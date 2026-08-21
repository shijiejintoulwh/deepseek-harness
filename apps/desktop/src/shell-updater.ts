/**
 * State-driven Electron shell updating over a narrow host adapter. The core
 * owns signed release policy and byte verification; Electron owns transport,
 * installer preparation, and the final application restart.
 */

import {
  type CurrentShellRelease,
  type ShellUpdateIncompatibility,
  type ShellUpdateManifest,
  evaluateShellUpdate,
  parseShellUpdateManifest,
  shellManifestSha256,
  verifyShellUpdateFile,
  verifyShellUpdateManifestSignature,
} from './shell-update-model.ts'
import { prerelease, valid } from 'semver'

export type { ShellUpdateChannel } from './shell-update-model.ts'

/** Exact signed material returned by desktop release discovery. */
export interface ShellUpdateEnvelope {
  /** Exact JSON bytes covered by the detached signature. */
  readonly manifestBytes: Buffer
  /** Detached base64 Ed25519 signature. */
  readonly signatureText: string
}

/** Local files returned by the Electron update implementation. */
export interface DownloadedShellUpdate {
  /** Local NSIS installer path. */
  readonly installerPath: string
  /** Local differential blockmap path. */
  readonly blockmapPath: string
}

/** Transport progress reported to the shell UI. */
export interface ShellUpdateDownloadProgress {
  /** Downloaded transport bytes. */
  readonly received: number
  /** Total transport bytes when known. */
  readonly total: number | null
}

/**
 * Minimal boundary implemented with electron-updater in the Electron main
 * process and replaced with an in-memory fake in core tests.
 */
export interface ShellUpdateAdapter {
  /** Discover the newest channel candidate and its custom signed manifest. */
  checkForUpdates(signal: AbortSignal): Promise<ShellUpdateEnvelope | null>
  /** Download installer and blockmap for a verified candidate. */
  downloadUpdate(
    manifest: ShellUpdateManifest,
    onProgress: (progress: ShellUpdateDownloadProgress) => void,
    signal: AbortSignal,
  ): Promise<DownloadedShellUpdate>
  /** Bind verified local paths to the updater's final install operation. */
  prepareUpdate(manifest: ShellUpdateManifest, downloaded: DownloadedShellUpdate): Promise<void>
  /** Remove incomplete or rejected local update files. */
  discardUpdate(downloaded: DownloadedShellUpdate): Promise<void>
  /** Quit the application and start the already-prepared NSIS update. */
  installUpdate(): void
}

/** Verified candidate retained between checking and downloading. */
export interface AvailableShellUpdate {
  /** Strictly validated signed manifest. */
  readonly manifest: ShellUpdateManifest
  /** SHA-256 of exact signed manifest bytes. */
  readonly manifestSha256: string
}

/** Operation that produced an updater failure. */
export type ShellUpdateOperation = 'check' | 'download' | 'install'

/** Stable error codes suitable for UI-specific rendering. */
export type ShellUpdateErrorCode =
  | 'invalid-state'
  | 'check-failed'
  | 'invalid-release'
  | 'immutable-version-conflict'
  | 'download-failed'
  | 'verification-failed'
  | 'prepare-failed'
  | 'install-failed'

/** Explicit state emitted for every user-visible shell update phase. */
export type ShellUpdateState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'none'; readonly reason: 'not-found' | 'current' | 'older' }
  | {
    readonly kind: 'incompatible'
    readonly reason: ShellUpdateIncompatibility
    readonly release: AvailableShellUpdate
  }
  | { readonly kind: 'available'; readonly release: AvailableShellUpdate }
  | {
    readonly kind: 'downloading'
    readonly release: AvailableShellUpdate
    readonly progress: ShellUpdateDownloadProgress
  }
  | {
    readonly kind: 'verified'
    readonly release: AvailableShellUpdate
    readonly downloaded: DownloadedShellUpdate
  }
  | {
    readonly kind: 'ready'
    readonly release: AvailableShellUpdate
    readonly downloaded: DownloadedShellUpdate
  }
  | { readonly kind: 'installing'; readonly release: AvailableShellUpdate }
  | {
    readonly kind: 'cancelled'
    readonly operation: 'check' | 'download'
    readonly release?: AvailableShellUpdate
  }
  | {
    readonly kind: 'error'
    readonly operation: ShellUpdateOperation
    readonly code: ShellUpdateErrorCode
    readonly message: string
    readonly release?: AvailableShellUpdate
    /** Verified files retained only when Electron rejected the install handoff. */
    readonly downloaded?: DownloadedShellUpdate
  }

/** Listener for state transitions rendered by the Electron integration. */
export type ShellUpdateStateListener = (state: ShellUpdateState) => void

/** Whether a caught error represents explicit caller cancellation. */
function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error as Error | null)?.name === 'AbortError'
}

/** Convert an unknown failure into a safe UI diagnostic string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Discover, verify, download, and install desktop shell updates. */
export class ShellUpdater {
  private currentState: ShellUpdateState = { kind: 'idle' }
  private readonly listeners = new Set<ShellUpdateStateListener>()

  /**
   * @param adapter - Electron-specific transport and install implementation.
   * @param current - current desktop release identity and selected channel.
   * @param desktopPublicKeyPem - dedicated desktop release Ed25519 public key.
   */
  constructor(
    private readonly adapter: ShellUpdateAdapter,
    private readonly current: CurrentShellRelease,
    private readonly desktopPublicKeyPem: string,
  ) {
    if (valid(current.version) === null) {
      throw new Error(`invalid current desktop semantic version: ${current.version}`)
    }
    const currentIsPreview = prerelease(current.version) !== null
    if ((current.channel === 'preview') !== currentIsPreview) {
      throw new Error('current desktop channel must agree with its semantic version prerelease marker')
    }
    if (current.manifestSha256 !== undefined && !/^[0-9a-f]{64}$/.test(current.manifestSha256)) {
      throw new Error('current desktop manifest SHA-256 is invalid')
    }
  }

  /** Current immutable state snapshot. */
  get state(): ShellUpdateState {
    return this.currentState
  }

  /**
   * Register a state listener.
   * @param listener - callback invoked synchronously after each transition.
   * @returns Disposer that removes the listener.
   */
  onStateChange(listener: ShellUpdateStateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Publish one state snapshot to every registered listener. */
  private transition(state: ShellUpdateState): ShellUpdateState {
    this.currentState = state
    for (const listener of this.listeners) listener(state)
    return state
  }

  /**
   * Discover and authenticate the next desktop release without downloading it.
   * @param signal - cancellation signal.
   * @returns Terminal check state.
   */
  async check(signal: AbortSignal): Promise<ShellUpdateState> {
    if (this.currentState.kind === 'checking' || this.currentState.kind === 'downloading') {
      return this.fail('check', 'invalid-state', 'a desktop update operation is already running')
    }
    this.transition({ kind: 'checking' })
    let envelope: ShellUpdateEnvelope | null
    try {
      envelope = await this.adapter.checkForUpdates(signal)
    } catch (error) {
      if (isCancelled(error, signal)) return this.transition({ kind: 'cancelled', operation: 'check' })
      return this.fail('check', 'check-failed', errorMessage(error))
    }
    if (signal.aborted) return this.transition({ kind: 'cancelled', operation: 'check' })
    if (envelope === null) return this.transition({ kind: 'none', reason: 'not-found' })

    let release: AvailableShellUpdate
    try {
      verifyShellUpdateManifestSignature(
        envelope.manifestBytes,
        envelope.signatureText,
        this.desktopPublicKeyPem,
      )
      release = {
        manifest: parseShellUpdateManifest(envelope.manifestBytes),
        manifestSha256: shellManifestSha256(envelope.manifestBytes),
      }
    } catch (error) {
      return this.fail('check', 'invalid-release', errorMessage(error))
    }

    const policy = evaluateShellUpdate(release.manifest, this.current)
    if (policy.kind === 'incompatible') {
      return this.transition({ kind: 'incompatible', reason: policy.reason, release })
    }
    if (policy.kind === 'older') return this.transition({ kind: 'none', reason: 'older' })
    if (policy.kind === 'current') {
      if (
        this.current.manifestSha256 !== undefined
        && this.current.manifestSha256 !== release.manifestSha256
      ) {
        return this.fail(
          'check',
          'immutable-version-conflict',
          `desktop version ${release.manifest.version} was published with different signed bytes`,
          release,
        )
      }
      return this.transition({ kind: 'none', reason: 'current' })
    }
    return this.transition({ kind: 'available', release })
  }

  /**
   * Download and verify the candidate returned by {@link check}.
   * @param signal - cancellation signal.
   * @returns Ready, cancelled, or error state.
   */
  async download(signal: AbortSignal): Promise<ShellUpdateState> {
    const release = this.currentState.kind === 'available'
      ? this.currentState.release
      : this.currentState.kind === 'cancelled' && this.currentState.operation === 'download'
        ? this.currentState.release
        : this.currentState.kind === 'error' && this.currentState.operation === 'download'
          ? this.currentState.release
          : undefined
    if (release === undefined) {
      return this.fail('download', 'invalid-state', 'no verified desktop update is available')
    }
    this.transition({
      kind: 'downloading',
      release,
      progress: { received: 0, total: null },
    })
    let downloaded: DownloadedShellUpdate | undefined
    let phase: 'download' | 'verification' | 'prepare' = 'download'
    try {
      downloaded = await this.adapter.downloadUpdate(
        release.manifest,
        (progress) => {
          if (progress.received < 0 || (progress.total !== null && progress.total < progress.received)) {
            throw new Error('desktop update adapter reported invalid download progress')
          }
          this.transition({ kind: 'downloading', release, progress })
        },
        signal,
      )
      phase = 'verification'
      await this.verifyDownloaded(release, downloaded, signal)
      this.transition({ kind: 'verified', release, downloaded })
      phase = 'prepare'
      await this.adapter.prepareUpdate(release.manifest, downloaded)
      return this.transition({ kind: 'ready', release, downloaded })
    } catch (error) {
      if (downloaded !== undefined) {
        try {
          await this.adapter.discardUpdate(downloaded)
        } catch (cleanupError) {
          return this.fail(
            'download',
            'download-failed',
            new AggregateError([error, cleanupError], 'desktop update and cleanup both failed').message,
            release,
          )
        }
      }
      if (isCancelled(error, signal)) {
        return this.transition({ kind: 'cancelled', operation: 'download', release })
      }
      const code = phase === 'download'
        ? 'download-failed'
        : phase === 'prepare'
          ? 'prepare-failed'
          : 'verification-failed'
      return this.fail('download', code, errorMessage(error), release)
    }
  }

  /**
   * Reverify ready files and hand control to Electron's NSIS install path.
   * @param signal - cancellation signal for the final local verification.
   * @returns Installing or error state.
   */
  async install(signal: AbortSignal): Promise<ShellUpdateState> {
    const ready = this.currentState.kind === 'ready'
      ? this.currentState
      : this.currentState.kind === 'error'
        && this.currentState.operation === 'install'
        && this.currentState.downloaded !== undefined
        ? { kind: 'ready' as const, release: this.currentState.release, downloaded: this.currentState.downloaded }
        : undefined
    if (ready === undefined || ready.release === undefined) {
      return this.fail('install', 'invalid-state', 'no verified desktop update is ready to install')
    }
    const { release, downloaded } = ready
    let verified = false
    try {
      await this.verifyDownloaded(release, downloaded, signal)
      verified = true
      this.adapter.installUpdate()
      return this.transition({ kind: 'installing', release })
    } catch (error) {
      if (!verified) {
        try {
          await this.adapter.discardUpdate(downloaded)
        } catch (cleanupError) {
          return this.fail(
            'install',
            'install-failed',
            new AggregateError([error, cleanupError], 'desktop update verification and cleanup both failed').message,
            release,
          )
        }
        return this.fail('install', 'install-failed', errorMessage(error), release)
      }
      return this.fail('install', 'install-failed', errorMessage(error), release, downloaded)
    }
  }

  /** Verify installer and blockmap against signed manifest fields. */
  private async verifyDownloaded(
    release: AvailableShellUpdate,
    downloaded: DownloadedShellUpdate,
    signal: AbortSignal,
  ): Promise<void> {
    await verifyShellUpdateFile(
      downloaded.installerPath,
      release.manifest.size,
      release.manifest.sha256,
      signal,
    )
    await verifyShellUpdateFile(
      downloaded.blockmapPath,
      release.manifest.blockmap.size,
      release.manifest.blockmap.sha256,
      signal,
    )
  }

  /** Enter one structured error state. */
  private fail(
    operation: ShellUpdateOperation,
    code: ShellUpdateErrorCode,
    message: string,
    release?: AvailableShellUpdate,
    downloaded?: DownloadedShellUpdate,
  ): ShellUpdateState {
    return this.transition({
      kind: 'error',
      operation,
      code,
      message,
      ...(release === undefined ? {} : { release }),
      ...(downloaded === undefined ? {} : { downloaded }),
    })
  }
}
