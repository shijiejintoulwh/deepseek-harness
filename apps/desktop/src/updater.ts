/**
 * Runtime update orchestration independent of Electron UI. Discovery never
 * mutates local selection; installation downloads and verifies a new immutable
 * directory, then stages it for the next launch while retaining the active one.
 */

import { unlink } from 'node:fs/promises'
import type { GitHubRuntimeProvider, AvailableRuntimeRelease, DownloadProgress } from './github-provider.ts'
import type { RuntimeStore } from './runtime-store.ts'
import {
  type RuntimeManifest,
  type RuntimeState,
  compareRuntimeVersions,
  isRuntimeCompatible,
  runtimeId,
  selectedRuntimeId,
  stageRuntime,
} from './runtime-model.ts'

/** Result of checking the signed release feed. */
export type RuntimeUpdateCheck =
  | { readonly kind: 'none' }
  | { readonly kind: 'skipped'; readonly version: string; readonly release: AvailableRuntimeRelease }
  | { readonly kind: 'desktop-required'; readonly release: AvailableRuntimeRelease }
  | { readonly kind: 'available'; readonly release: AvailableRuntimeRelease }

/** Installation progress phases presented by the desktop UI. */
export type RuntimeUpdateProgress =
  | { readonly phase: 'downloading'; readonly progress: DownloadProgress }
  | { readonly phase: 'verifying' }
  | { readonly phase: 'staged'; readonly runtimeId: string }

/** Whether a missing-file cleanup error can be ignored. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Discover, install, and stage signed Harness releases. */
export class RuntimeUpdater {
  /**
   * @param provider - public release discovery and download provider.
   * @param store - versioned runtime storage owner.
   * @param desktopVersion - current Electron host version.
   * @param protocolVersion - update/start protocol implemented by the host.
   */
  constructor(
    private readonly provider: GitHubRuntimeProvider,
    private readonly store: RuntimeStore,
    private readonly desktopVersion: string,
    private readonly protocolVersion: number,
  ) {}

  /**
   * Compare the latest signed release with the selected runtime (staged
   * pending when present, otherwise active) and host compatibility.
   * @param state - current runtime selection.
   * @returns User-actionable update status.
   */
  async check(state: RuntimeState): Promise<RuntimeUpdateCheck> {
    const latest = await this.provider.latest()
    if (latest === null) return { kind: 'none' }

    let current: RuntimeManifest | null = null
    const selected = selectedRuntimeId(state)
    if (selected !== null) current = await this.store.readInstalledManifest(selected)
    if (current !== null && compareRuntimeVersions(latest.manifest, current) <= 0) return { kind: 'none' }

    const id = runtimeId(latest.manifest)
    if (state.skipped === id) return { kind: 'skipped', version: id, release: latest }
    if (!isRuntimeCompatible(latest.manifest, this.desktopVersion, this.protocolVersion)) {
      return { kind: 'desktop-required', release: latest }
    }
    return { kind: 'available', release: latest }
  }

  /**
   * Download, verify, install, and stage one release for the next launch.
   * @param release - candidate returned by {@link check}.
   * @param state - selection state read immediately before installation.
   * @param onProgress - progress callback.
   * @param signal - cancellation signal.
   * @returns Persisted staged state.
   */
  async install(
    release: AvailableRuntimeRelease,
    state: RuntimeState,
    onProgress: (progress: RuntimeUpdateProgress) => void,
    signal: AbortSignal,
  ): Promise<RuntimeState> {
    const archive = await this.provider.download(
      release,
      this.store.paths.downloads,
      (progress) => {
        onProgress({ phase: 'downloading', progress })
      },
      signal,
    )
    let installed: Awaited<ReturnType<RuntimeStore['install']>>
    try {
      onProgress({ phase: 'verifying' })
      installed = await this.store.install({
        manifestBytes: release.manifestBytes,
        signatureText: release.signatureText,
        archivePath: archive,
      })
    } finally {
      try {
        await unlink(archive)
      } catch (error) {
        if (!isENOENT(error)) throw error
      }
    }
    const next = stageRuntime(state, installed.id)
    await this.store.writeState(next)
    onProgress({ phase: 'staged', runtimeId: installed.id })
    return next
  }
}
