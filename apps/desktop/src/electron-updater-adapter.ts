/** Electron-updater and NSIS implementation of the shell update adapter. */

import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { finished } from 'node:stream/promises'
import {
  autoUpdater,
  CancellationToken,
  type ProgressInfo,
} from 'electron-updater'
import type { DesktopReleaseLocation, GitHubDesktopReleaseSource } from './desktop-release-source.ts'
import type { ShellUpdateManifest } from './shell-update-model.ts'
import type {
  DownloadedShellUpdate,
  ShellUpdateAdapter,
  ShellUpdateChannel,
  ShellUpdateDownloadProgress,
  ShellUpdateEnvelope,
} from './shell-updater.ts'

/** Whether a cleanup error means the file is already absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Remove one exact updater-owned file. */
async function removeOwnedFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isENOENT(error)) throw error
  }
}

/** Stream one signed release asset to an exclusive private file. */
async function downloadSignedAsset(
  url: string,
  destination: string,
  expectedSize: number,
  receivedOffset: number,
  total: number,
  onProgress: (progress: ShellUpdateDownloadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'DeepSeek-Harness-Desktop' },
    signal,
  })
  if (!response.ok || response.body === null) {
    throw new Error(`desktop update asset download failed with ${response.status}`)
  }
  const declaredSize = response.headers.get('content-length')
  if (declaredSize !== null && Number(declaredSize) !== expectedSize) {
    await response.body.cancel()
    throw new Error('desktop update asset Content-Length disagrees with its signed size')
  }

  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  const completion = finished(output)
  const reader = response.body.getReader()
  let received = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      received += result.value.byteLength
      if (received > expectedSize) {
        throw new Error(`desktop update asset exceeded its signed size of ${expectedSize} bytes`)
      }
      if (!output.write(result.value)) await once(output, 'drain')
      onProgress({ received: receivedOffset + received, total })
    }
    output.end()
    await completion
    if (received !== expectedSize) {
      throw new Error(`desktop update asset ended at ${received} bytes; expected ${expectedSize}`)
    }
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      // The transfer failure remains authoritative.
    }
    output.destroy()
    try {
      await completion
    } catch {
      // The transfer failure remains authoritative.
    }
    try {
      await removeOwnedFile(destination)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'desktop asset download and cleanup both failed')
    }
    throw error
  }
}

/**
 * Whether Electron update metadata names the signed installer exactly once.
 * @param files - Raw relative or absolute file URLs parsed by electron-updater.
 * @param asset - Installer basename committed by the signed manifest.
 * @returns Whether exactly one metadata entry names the installer.
 */
export function metadataContainsInstaller(files: readonly { readonly url: string }[], asset: string): boolean {
  const matches = files.filter((file) => {
    try {
      return basename(decodeURIComponent(new URL(file.url, 'https://desktop-update.invalid/').pathname)) === asset
    } catch {
      return false
    }
  })
  return matches.length === 1
}

/** Shell adapter backed by electron-updater's generic provider and NSIS handoff. */
export class ElectronUpdaterAdapter implements ShellUpdateAdapter {
  private location: DesktopReleaseLocation | null = null
  private prepared: DownloadedShellUpdate | null = null

  /**
   * @param source - signed desktop release discovery source.
   * @param channel - channel selected by the installed desktop version.
   * @param downloadDirectory - private directory for independently verified blockmaps.
   * @param onDiagnostic - updater diagnostics sink.
   */
  constructor(
    private readonly source: GitHubDesktopReleaseSource,
    private readonly channel: ShellUpdateChannel,
    private readonly downloadDirectory: string,
    onDiagnostic: (message: string) => void,
  ) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = channel === 'preview'
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = {
      info: (message) => { onDiagnostic(String(message)) },
      warn: (message) => { onDiagnostic(`warning: ${String(message)}`) },
      error: (message) => { onDiagnostic(`error: ${String(message)}`) },
    }
    autoUpdater.on('error', (error) => {
      onDiagnostic(`error: ${error.message}`)
    })
  }

  /** Discover exact signed bytes without downloading installer assets. */
  async checkForUpdates(signal: AbortSignal): Promise<ShellUpdateEnvelope | null> {
    this.location = await this.source.latest(this.channel, signal)
    this.prepared = null
    if (this.location === null) return null
    return {
      manifestBytes: this.location.manifestBytes,
      signatureText: this.location.signatureText,
    }
  }

  /** Download through electron-updater, then fetch the signed blockmap for independent verification. */
  async downloadUpdate(
    manifest: ShellUpdateManifest,
    onProgress: (progress: ShellUpdateDownloadProgress) => void,
    signal: AbortSignal,
  ): Promise<DownloadedShellUpdate> {
    const location = this.location
    if (location === null || location.version !== manifest.version) {
      throw new Error('desktop update manifest does not match the discovered release tag')
    }
    const channelFile = manifest.channel === 'stable' ? 'latest' : 'preview'
    autoUpdater.channel = channelFile
    autoUpdater.allowDowngrade = false
    autoUpdater.setFeedURL({ provider: 'generic', url: location.assetBaseUrl, channel: channelFile })
    const check = await autoUpdater.checkForUpdates()
    if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
    if (check === null || !check.isUpdateAvailable || check.updateInfo.version !== manifest.version) {
      throw new Error('Electron update metadata does not select the signed desktop version')
    }
    if (!metadataContainsInstaller(check.updateInfo.files, manifest.asset)) {
      throw new Error('Electron update metadata does not name the signed desktop installer exactly once')
    }

    const token = new CancellationToken()
    const cancel = (): void => { token.cancel() }
    signal.addEventListener('abort', cancel, { once: true })
    const total = manifest.size + manifest.blockmap.size
    const report = (progress: ProgressInfo): void => {
      onProgress({ received: Math.min(progress.transferred, manifest.size), total })
    }
    autoUpdater.on('download-progress', report)
    let installerPaths: string[]
    try {
      installerPaths = await autoUpdater.downloadUpdate(token)
    } finally {
      signal.removeEventListener('abort', cancel)
      autoUpdater.removeListener('download-progress', report)
    }
    const installerPath = installerPaths[0]
    if (installerPaths.length !== 1 || installerPath === undefined) {
      throw new Error('electron-updater did not return exactly one downloaded installer')
    }

    await mkdir(this.downloadDirectory, { recursive: true, mode: 0o700 })
    const blockmapPath = join(this.downloadDirectory, `${manifest.blockmap.asset}.download`)
    await removeOwnedFile(blockmapPath)
    try {
      await downloadSignedAsset(
        new URL(manifest.blockmap.asset, location.assetBaseUrl).href,
        blockmapPath,
        manifest.blockmap.size,
        manifest.size,
        total,
        onProgress,
        signal,
      )
    } catch (error) {
      try {
        await removeOwnedFile(installerPath)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'desktop update and installer cleanup both failed')
      }
      throw error
    }
    return { installerPath, blockmapPath }
  }

  /** Retain the files already staged by electron-updater for explicit install only. */
  prepareUpdate(manifest: ShellUpdateManifest, downloaded: DownloadedShellUpdate): Promise<void> {
    if (this.location?.version !== manifest.version) {
      throw new Error('desktop update preparation no longer matches the discovered release')
    }
    this.prepared = downloaded
    return Promise.resolve()
  }

  /** Remove rejected local bytes so electron-updater cannot hand them to NSIS. */
  async discardUpdate(downloaded: DownloadedShellUpdate): Promise<void> {
    const failures: unknown[] = []
    for (const path of [downloaded.installerPath, downloaded.blockmapPath]) {
      try {
        await removeOwnedFile(path)
      } catch (error) {
        failures.push(error)
      }
    }
    if (this.prepared === downloaded) this.prepared = null
    if (failures.length !== 0) throw new AggregateError(failures, 'desktop update cleanup failed')
  }

  /** Start the assisted NSIS installer only for the verified prepared files. */
  installUpdate(): void {
    if (this.prepared === null) throw new Error('desktop update files are not prepared')
    autoUpdater.quitAndInstall(false, true)
  }
}
