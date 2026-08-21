import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellUpdateManifest } from '../src/shell-update-model.ts'
import {
  type DownloadedShellUpdate,
  type ShellUpdateAdapter,
  type ShellUpdateDownloadProgress,
  type ShellUpdateEnvelope,
  ShellUpdater,
} from '../src/shell-updater.ts'

const temporaryDirectories: string[] = []

interface SignedFixture {
  readonly envelope: ShellUpdateEnvelope
  readonly publicKey: string
  readonly manifestSha256: string
}

function signedFixture(overrides: Record<string, unknown> = {}): SignedFixture {
  const installer = Buffer.from('signed installer bytes')
  const blockmap = Buffer.from('signed blockmap bytes')
  const keys = generateKeyPairSync('ed25519')
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    version: '1.0.5-preview.1',
    channel: 'preview',
    platform: 'win32',
    arch: 'x64',
    asset: 'desktop.exe',
    size: installer.length,
    sha256: createHash('sha256').update(installer).digest('hex'),
    blockmap: {
      asset: 'desktop.exe.blockmap',
      size: blockmap.length,
      sha256: createHash('sha256').update(blockmap).digest('hex'),
    },
    sourceCommit: 'd'.repeat(40),
    publishedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  })}\n`)
  return {
    envelope: {
      manifestBytes: bytes,
      signatureText: sign(null, bytes, keys.privateKey).toString('base64'),
    },
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function downloadedFixture(): Promise<DownloadedShellUpdate> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-shell-updater-'))
  temporaryDirectories.push(directory)
  const installerPath = join(directory, 'desktop.exe')
  const blockmapPath = join(directory, 'desktop.exe.blockmap')
  await Promise.all([
    writeFile(installerPath, 'signed installer bytes'),
    writeFile(blockmapPath, 'signed blockmap bytes'),
  ])
  return { installerPath, blockmapPath }
}

function adapter(
  envelope: ShellUpdateEnvelope | null,
  downloaded?: DownloadedShellUpdate,
): ShellUpdateAdapter & {
  prepareUpdate: ReturnType<typeof vi.fn>
  discardUpdate: ReturnType<typeof vi.fn>
  installUpdate: ReturnType<typeof vi.fn>
} {
  return {
    async checkForUpdates(): Promise<ShellUpdateEnvelope | null> {
      return envelope
    },
    async downloadUpdate(
      _manifest: ShellUpdateManifest,
      onProgress: (progress: ShellUpdateDownloadProgress) => void,
    ): Promise<DownloadedShellUpdate> {
      onProgress({ received: 10, total: 20 })
      if (downloaded === undefined) throw new Error('download unavailable')
      return downloaded
    },
    prepareUpdate: vi.fn(async () => {}),
    discardUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn((): void => {}),
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('desktop shell updater', () => {
  it('emits checking and available only after signature verification', async () => {
    const fixture = signedFixture()
    const host = adapter(fixture.envelope)
    const updater = new ShellUpdater(host, {
      version: '1.0.4-preview.1', channel: 'preview', platform: 'win32', arch: 'x64',
    }, fixture.publicKey)
    const states: string[] = []
    updater.onStateChange(state => states.push(state.kind))

    await expect(updater.check(new AbortController().signal)).resolves.toMatchObject({ kind: 'available' })
    expect(states).toEqual(['checking', 'available'])

    const wrongKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const rejected = new ShellUpdater(adapter(fixture.envelope), {
      version: '1.0.4-preview.1', channel: 'preview', platform: 'win32', arch: 'x64',
    }, wrongKey)
    await expect(rejected.check(new AbortController().signal)).resolves.toMatchObject({
      kind: 'error', operation: 'check', code: 'invalid-release',
    })
  })

  it('reports none, incompatible, and immutable same-version bytes explicitly', async () => {
    const preview = signedFixture()
    const stableHost = new ShellUpdater(adapter(preview.envelope), {
      version: '1.0.4', channel: 'stable', platform: 'win32', arch: 'x64',
    }, preview.publicKey)
    await expect(stableHost.check(new AbortController().signal)).resolves.toMatchObject({
      kind: 'incompatible', reason: 'channel',
    })

    const older = signedFixture({ version: '1.0.3-preview.9' })
    const previewHost = new ShellUpdater(adapter(older.envelope), {
      version: '1.0.4-preview.1', channel: 'preview', platform: 'win32', arch: 'x64',
    }, older.publicKey)
    await expect(previewHost.check(new AbortController().signal)).resolves.toEqual({ kind: 'none', reason: 'older' })

    const current = signedFixture({ version: '1.0.4-preview.1' })
    const conflict = new ShellUpdater(adapter(current.envelope), {
      version: '1.0.4-preview.1',
      channel: 'preview',
      platform: 'win32',
      arch: 'x64',
      manifestSha256: '0'.repeat(64),
    }, current.publicKey)
    await expect(conflict.check(new AbortController().signal)).resolves.toMatchObject({
      kind: 'error', code: 'immutable-version-conflict',
    })
  })

  it('verifies both assets before becoming ready and reverifies before install', async () => {
    const fixture = signedFixture()
    const downloaded = await downloadedFixture()
    const host = adapter(fixture.envelope, downloaded)
    const updater = new ShellUpdater(host, {
      version: '1.0.4-preview.1', channel: 'preview', platform: 'win32', arch: 'x64',
    }, fixture.publicKey)
    const states: string[] = []
    updater.onStateChange(state => states.push(state.kind))

    await updater.check(new AbortController().signal)
    await expect(updater.download(new AbortController().signal)).resolves.toMatchObject({ kind: 'ready' })
    expect(states).toEqual(['checking', 'available', 'downloading', 'downloading', 'verified', 'ready'])
    expect(host.prepareUpdate).toHaveBeenCalledOnce()

    await expect(updater.install(new AbortController().signal)).resolves.toMatchObject({ kind: 'installing' })
    expect(host.installUpdate).toHaveBeenCalledOnce()
  })

  it('rejects tampering, discards rejected files, and never marks them ready', async () => {
    const fixture = signedFixture()
    const downloaded = await downloadedFixture()
    await writeFile(downloaded.installerPath, 'tampered installer')
    const host = adapter(fixture.envelope, downloaded)
    const updater = new ShellUpdater(host, {
      version: '1.0.4-preview.1', channel: 'preview', platform: 'win32', arch: 'x64',
    }, fixture.publicKey)

    await updater.check(new AbortController().signal)
    await expect(updater.download(new AbortController().signal)).resolves.toMatchObject({
      kind: 'error', code: 'verification-failed',
    })
    expect(host.discardUpdate).toHaveBeenCalledWith(downloaded)
    expect(host.prepareUpdate).not.toHaveBeenCalled()
    expect(host.installUpdate).not.toHaveBeenCalled()
  })

  it('rechecks ready bytes before install and rejects post-download replacement', async () => {
    const fixture = signedFixture()
    const downloaded = await downloadedFixture()
    const host = adapter(fixture.envelope, downloaded)
    const updater = new ShellUpdater(host, {
      version: '1.0.4-preview.1', channel: 'preview', platform: 'win32', arch: 'x64',
    }, fixture.publicKey)

    await updater.check(new AbortController().signal)
    await updater.download(new AbortController().signal)
    await writeFile(downloaded.installerPath, 'replaced after ready')
    await expect(updater.install(new AbortController().signal)).resolves.toMatchObject({
      kind: 'error', code: 'install-failed',
    })
    expect(host.discardUpdate).toHaveBeenCalledWith(downloaded)
    expect(host.installUpdate).not.toHaveBeenCalled()
  })

  it('retains verified files when Electron rejects install handoff and permits retry', async () => {
    const fixture = signedFixture()
    const downloaded = await downloadedFixture()
    const host = adapter(fixture.envelope, downloaded)
    host.installUpdate.mockImplementationOnce(() => {
      throw new Error('NSIS handoff failed')
    })
    const updater = new ShellUpdater(host, {
      version: '1.0.4-preview.1', channel: 'preview', platform: 'win32', arch: 'x64',
    }, fixture.publicKey)

    await updater.check(new AbortController().signal)
    await updater.download(new AbortController().signal)
    await expect(updater.install(new AbortController().signal)).resolves.toMatchObject({
      kind: 'error', code: 'install-failed', downloaded,
    })
    expect(host.discardUpdate).not.toHaveBeenCalled()
    await expect(updater.install(new AbortController().signal)).resolves.toMatchObject({ kind: 'installing' })
    expect(host.installUpdate).toHaveBeenCalledTimes(2)
  })

  it('reports download progress and cancellation without preparing an installer', async () => {
    const fixture = signedFixture()
    const controller = new AbortController()
    const host = adapter(fixture.envelope)
    host.downloadUpdate = async (_manifest, onProgress) => {
      onProgress({ received: 5, total: 10 })
      controller.abort()
      throw new DOMException('cancelled', 'AbortError')
    }
    const updater = new ShellUpdater(host, {
      version: '1.0.4-preview.1', channel: 'preview', platform: 'win32', arch: 'x64',
    }, fixture.publicKey)
    const progress: ShellUpdateDownloadProgress[] = []
    updater.onStateChange((state) => {
      if (state.kind === 'downloading') progress.push(state.progress)
    })

    await updater.check(new AbortController().signal)
    await expect(updater.download(controller.signal)).resolves.toMatchObject({
      kind: 'cancelled', operation: 'download',
    })
    expect(progress).toEqual([{ received: 0, total: null }, { received: 5, total: 10 }])
    expect(host.prepareUpdate).not.toHaveBeenCalled()
  })
})
