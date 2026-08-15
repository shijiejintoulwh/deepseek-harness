/**
 * Versioned Harness runtime storage. Installation verifies signed metadata and
 * archive bytes before extracting into a random sibling, validates every ZIP
 * entry, then renames the completed directory into the selectable version set.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
} from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import extractZip from 'extract-zip'
import {
  EMPTY_RUNTIME_STATE,
  type RuntimeManifest,
  type RuntimeState,
  parseRuntimeManifest,
  runtimeId,
  runtimeStateSchema,
  verifyManifestSignature,
} from './runtime-model.ts'
import { isMissingFilesystemError, removeTreeNoFollow } from './safe-fs.ts'

/** Paths owned by the desktop runtime store. */
export interface RuntimeStorePaths {
  /** Root for version directories and updater state. */
  readonly root: string
  /** Installed, immutable runtime directories. */
  readonly versions: string
  /** In-progress downloaded archives. */
  readonly downloads: string
  /** Atomic runtime-selection document. */
  readonly state: string
}

/** Inputs carried by one release or bundled seed directory. */
export interface RuntimeReleaseBundle {
  /** Exact signed manifest bytes. */
  readonly manifestBytes: Buffer
  /** Detached base64 Ed25519 signature. */
  readonly signatureText: string
  /** Downloaded runtime ZIP. */
  readonly archivePath: string
}

/**
 * Construct the fixed store layout under one caller-owned root.
 * @param root - absolute desktop runtime-data root.
 * @returns Derived store paths.
 */
function runtimeStorePaths(root: string): RuntimeStorePaths {
  const absolute = resolve(root)
  return {
    root: absolute,
    versions: join(absolute, 'runtimes'),
    downloads: join(absolute, 'downloads'),
    state: join(absolute, 'runtime-state.json'),
  }
}

/**
 * Reject a ZIP name that could escape or alias the extraction root.
 * @param entryName - raw ZIP entry name.
 */
export function assertSafeArchiveEntry(entryName: string): void {
  if (entryName === '' || entryName.includes('\0') || isAbsolute(entryName) || /^[A-Za-z]:/.test(entryName)) {
    throw new Error(`unsafe runtime archive entry: ${JSON.stringify(entryName)}`)
  }
  const segments = entryName.replaceAll('\\', '/').split('/')
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error(`unsafe runtime archive entry: ${JSON.stringify(entryName)}`)
  }
}

/**
 * Compute a lowercase SHA-256 digest without buffering an archive in memory.
 * @param filename - regular file to hash.
 * @returns Hex digest.
 */
async function sha256File(filename: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filename) as AsyncIterable<Buffer>) digest.update(chunk)
  return digest.digest('hex')
}

/** Return whether a ZIP entry advertises a Unix symbolic-link file type. */
function isZipSymlink(externalFileAttributes: number): boolean {
  const unixMode = externalFileAttributes >>> 16
  return (unixMode & 0o170000) === 0o120000
}

/**
 * Storage owner for installed runtimes and their atomic selection document.
 */
export class RuntimeStore {
  readonly paths: RuntimeStorePaths

  /**
   * @param root - desktop-owned runtime-data root.
   * @param publicKeyPem - trusted manifest verification key.
   */
  constructor(root: string, private readonly publicKeyPem: string) {
    this.paths = runtimeStorePaths(root)
  }

  /** Create private store directories without altering existing contents. */
  async prepare(): Promise<void> {
    await mkdir(this.paths.versions, { recursive: true, mode: 0o700 })
    await mkdir(this.paths.downloads, { recursive: true, mode: 0o700 })
  }

  /**
   * Read and validate runtime selection; an absent document means no seed has
   * been installed, while malformed content fails startup.
   * @returns Current state.
   */
  async readState(): Promise<RuntimeState> {
    try {
      return runtimeStateSchema.parse(JSON.parse(await readFile(this.paths.state, 'utf8')) as unknown)
    } catch (error) {
      if (isMissingFilesystemError(error)) return EMPTY_RUNTIME_STATE
      throw error
    }
  }

  /**
   * Atomically publish validated runtime selection.
   * @param state - complete next state.
   */
  async writeState(state: RuntimeState): Promise<void> {
    const validated = runtimeStateSchema.parse(state)
    await writeFileAtomic(this.paths.state, `${JSON.stringify(validated, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  /**
   * Resolve one validated id below the immutable versions root.
   * @param id - runtime directory id.
   * @returns Absolute runtime directory.
   */
  runtimeDirectory(id: string): string {
    const validated = runtimeStateSchema.shape.active.unwrap().parse(id)
    const directory = join(this.paths.versions, validated)
    // runtimeStateSchema limits ids to one safe path segment.
    return directory
  }

  /**
   * Read one installed runtime's local manifest.
   * @param id - installed runtime id.
   * @returns Validated manifest.
   */
  async readInstalledManifest(id: string): Promise<RuntimeManifest> {
    const bytes = await readFile(join(this.runtimeDirectory(id), 'runtime-manifest.json'))
    return parseRuntimeManifest(bytes)
  }

  /**
   * Verify and install a complete release bundle without changing selection.
   * @param bundle - signed manifest and matching archive.
   * @returns Installed manifest and directory id.
   */
  async install(bundle: RuntimeReleaseBundle): Promise<{ manifest: RuntimeManifest; id: string }> {
    await this.prepare()
    verifyManifestSignature(bundle.manifestBytes, bundle.signatureText, this.publicKeyPem)
    const manifest = parseRuntimeManifest(bundle.manifestBytes)
    const archiveInfo = await lstat(bundle.archivePath)
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) {
      throw new Error(`runtime archive is not a regular file: ${bundle.archivePath}`)
    }
    if (archiveInfo.size !== manifest.size) {
      throw new Error(`runtime archive size ${archiveInfo.size} does not match signed size ${manifest.size}`)
    }
    const digest = await sha256File(bundle.archivePath)
    if (digest !== manifest.sha256) {
      throw new Error(`runtime archive SHA-256 ${digest} does not match signed digest ${manifest.sha256}`)
    }

    const id = runtimeId(manifest)
    const target = this.runtimeDirectory(id)
    try {
      const installed = await this.readInstalledManifest(id)
      if (installed.sha256 !== manifest.sha256) {
        throw new Error(`installed runtime ${id} disagrees with the signed release`)
      }
      return { manifest: installed, id }
    } catch (error) {
      if (!isMissingFilesystemError(error)) throw error
    }

    const staging = join(this.paths.versions, `.install-${id}-${randomBytes(6).toString('hex')}`)
    await mkdir(staging, { mode: 0o700 })
    try {
      await extractZip(bundle.archivePath, {
        dir: staging,
        onEntry: (entry) => {
          assertSafeArchiveEntry(entry.fileName)
          if (isZipSymlink(entry.externalFileAttributes)) {
            throw new Error(`runtime archive contains a symbolic link: ${entry.fileName}`)
          }
        },
      })
      await access(join(staging, 'node', 'node.exe'))
      await access(join(staging, 'app', 'lib', 'bin.js'))
      await writeFileAtomic(join(staging, 'runtime-manifest.json'), bundle.manifestBytes.toString('utf8'), {
        mode: 0o600,
        dirMode: 0o700,
      })
      await rename(staging, target)
    } catch (error) {
      await removeTreeNoFollow(this.paths.versions, staging)
      throw error
    }
    return { manifest, id }
  }

  /**
   * Load a release bundle from a seed or downloaded-asset directory.
   * @param directory - directory holding manifest, signature, and signed asset.
   * @returns Complete bundle.
   */
  async readReleaseBundle(directory: string): Promise<RuntimeReleaseBundle> {
    const manifestBytes = await readFile(join(directory, 'runtime-manifest.json'))
    const signatureText = await readFile(join(directory, 'runtime-manifest.sig'), 'utf8')
    verifyManifestSignature(manifestBytes, signatureText, this.publicKeyPem)
    const manifest = parseRuntimeManifest(manifestBytes)
    if (basename(manifest.asset) !== manifest.asset) throw new Error('runtime asset must be a filename')
    return { manifestBytes, signatureText, archivePath: join(directory, manifest.asset) }
  }

  /**
   * Remove installed versions that are not selected or retained for rollback.
   * @param state - current selection state.
   */
  async prune(state: RuntimeState): Promise<void> {
    const retained = new Set([state.active, state.previous, state.pending].filter(value => value !== null))
    for (const entry of await readdir(this.paths.versions, { withFileTypes: true })) {
      if (retained.has(entry.name)) continue
      await removeTreeNoFollow(this.paths.versions, join(this.paths.versions, entry.name))
    }
  }
}
