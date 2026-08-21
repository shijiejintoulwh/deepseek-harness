/** Canonical desktop-shell release manifests and release-set validation. */

import { createHash, createPrivateKey, sign } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

/** Supported desktop update channels. */
export type DesktopReleaseChannel = 'stable' | 'preview'

/** One measured release file in the signed desktop manifest. */
export interface DesktopReleaseFile {
  /** Basename published in the GitHub Release. */
  readonly asset: string
  /** Exact byte count. */
  readonly size: number
  /** Lowercase hexadecimal SHA-256 digest. */
  readonly sha256: string
}

/** Inputs measured or fixed by the reviewed release checkout. */
export interface DesktopManifestInput extends DesktopReleaseFile {
  /** Desktop package version. */
  readonly version: string
  /** Release channel derived from the version. */
  readonly channel: DesktopReleaseChannel
  /** Measured blockmap file. */
  readonly blockmap: DesktopReleaseFile
  /** Commit whose desktop sources produced the installer. */
  readonly sourceCommit: string
  /** ISO timestamp recorded when the release set was assembled. */
  readonly publishedAt: string
}

/** Signed JSON fields for one Windows x64 desktop shell. */
export interface DesktopUpdateManifest extends DesktopManifestInput {
  /** Desktop manifest schema revision. */
  readonly schemaVersion: 1
  /** Packaged operating system. */
  readonly platform: 'win32'
  /** Packaged CPU architecture. */
  readonly arch: 'x64'
}

/** Expected filenames for one desktop release version. */
export interface DesktopReleaseNames {
  /** NSIS installer basename. */
  readonly installer: string
  /** Differential blockmap basename. */
  readonly blockmap: string
  /** electron-updater channel metadata basename. */
  readonly metadata: 'latest.yml' | 'preview.yml'
}

/** Expectations supplied independently to release-set validation. */
export interface DesktopReleaseExpectations {
  /** Expected package version. */
  readonly version: string
  /** Expected desktop-v tag. */
  readonly tag: string
  /** Expected channel. */
  readonly channel: DesktopReleaseChannel
  /** Expected source commit. */
  readonly sourceCommit: string
}

/** Validated manifest bytes and parsed fields. */
export interface ValidatedDesktopRelease {
  /** Exact bytes covered by the detached signature. */
  readonly bytes: Buffer
  /** Parsed and validated manifest. */
  readonly manifest: DesktopUpdateManifest
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/
const SHA_256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const MAX_INSTALLER_SIZE = 1024 * 1024 * 1024
const MAX_BLOCKMAP_SIZE = 64 * 1024 * 1024
const MAX_METADATA_SIZE = 1024 * 1024
const MAX_MANIFEST_SIZE = 64 * 1024
const MANIFEST_KEYS = [
  'arch',
  'asset',
  'blockmap',
  'channel',
  'platform',
  'publishedAt',
  'schemaVersion',
  'sha256',
  'size',
  'sourceCommit',
  'version',
].sort()
const FILE_KEYS = ['asset', 'sha256', 'size'].sort()

/**
 * Resolve stable or preview solely from a supported desktop version.
 * @param version - Desktop package version.
 * @returns Release channel.
 */
export function desktopReleaseChannel(version: string): DesktopReleaseChannel {
  if (!VERSION.test(version)) throw new Error('desktop version must be stable SemVer or x.y.z-preview.n')
  return version.includes('-preview.') ? 'preview' : 'stable'
}

/**
 * Derive every versioned or channel-specific release filename.
 * @param version - Supported desktop package version.
 * @returns Installer, blockmap, and channel metadata names.
 */
export function desktopReleaseNames(version: string): DesktopReleaseNames {
  const channel = desktopReleaseChannel(version)
  const installer = `DeepSeek-Harness-Desktop-${version}-win-x64.exe`
  return {
    installer,
    blockmap: `${installer}.blockmap`,
    metadata: channel === 'preview' ? 'preview.yml' : 'latest.yml',
  }
}

/**
 * Build the canonical insertion-ordered manifest object.
 * @param input - Measured release fields.
 * @returns Complete desktop update manifest.
 */
export function desktopManifest(input: DesktopManifestInput): DesktopUpdateManifest {
  const expectedChannel = desktopReleaseChannel(input.version)
  if (input.channel !== expectedChannel) throw new Error('desktop release channel disagrees with version')
  validateReleaseFile(input, 'installer')
  validateReleaseFile(input.blockmap, 'blockmap')
  const names = desktopReleaseNames(input.version)
  if (input.asset !== names.installer || input.blockmap.asset !== names.blockmap) {
    throw new Error('desktop release filenames disagree with version')
  }
  if (!COMMIT.test(input.sourceCommit)) throw new Error('desktop source commit is invalid')
  if (new Date(input.publishedAt).toISOString() !== input.publishedAt) {
    throw new Error('desktop publishedAt must be a canonical ISO timestamp')
  }
  return {
    schemaVersion: 1,
    version: input.version,
    channel: input.channel,
    platform: 'win32',
    arch: 'x64',
    asset: input.asset,
    size: input.size,
    sha256: input.sha256,
    blockmap: input.blockmap,
    sourceCommit: input.sourceCommit,
    publishedAt: input.publishedAt,
  }
}

/**
 * Render the exact UTF-8 bytes signed and consumed by the desktop updater.
 * @param manifest - Complete desktop manifest.
 * @returns Two-space JSON with one trailing newline.
 */
export function renderDesktopManifest(manifest: DesktopUpdateManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * Sign exact manifest bytes with an Ed25519 PKCS#8 PEM private key.
 * @param bytes - Canonical manifest bytes.
 * @param privateKeyPem - Desktop release signing key.
 * @returns Base64 detached signature with one trailing newline.
 */
export function signDesktopManifest(bytes: Buffer, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('desktop update signing key must be Ed25519')
  return `${sign(null, bytes, key).toString('base64')}\n`
}

/**
 * Measure an exact three-file builder output and create its unsigned manifest.
 * @param directory - Directory containing only installer, blockmap, and channel metadata.
 * @param version - Desktop package version.
 * @param sourceCommit - Producing Git commit.
 * @param publishedAt - Canonical ISO release timestamp.
 * @returns Created manifest.
 */
export function generateDesktopManifest(
  directory: string,
  version: string,
  sourceCommit: string,
  publishedAt: string,
): DesktopUpdateManifest {
  const names = desktopReleaseNames(version)
  assertExactFiles(directory, [names.installer, names.blockmap, names.metadata])
  const installer = measureFile(directory, names.installer)
  const blockmap = measureFile(directory, names.blockmap)
  const manifest = desktopManifest({
    version,
    channel: desktopReleaseChannel(version),
    ...installer,
    blockmap,
    sourceCommit,
    publishedAt,
  })
  writeFileSync(join(directory, 'desktop-update-manifest.json'), renderDesktopManifest(manifest), {
    flag: 'wx',
    mode: 0o600,
  })
  return manifest
}

/**
 * Validate one unsigned release directory against independently supplied expectations.
 * @param directory - Directory containing the four unsigned release files.
 * @param expected - Version, tag, channel, and source commit expected by the workflow event.
 * @returns Exact manifest bytes and parsed fields.
 */
export function validateUnsignedDesktopRelease(
  directory: string,
  expected: DesktopReleaseExpectations,
): ValidatedDesktopRelease {
  const names = desktopReleaseNames(expected.version)
  if (expected.channel !== desktopReleaseChannel(expected.version)) {
    throw new Error('expected desktop channel disagrees with version')
  }
  if (expected.tag !== `desktop-v${expected.version}`) throw new Error('desktop release tag is invalid')
  if (!COMMIT.test(expected.sourceCommit)) throw new Error('expected desktop source commit is invalid')
  assertExactFiles(directory, [
    names.installer,
    names.blockmap,
    names.metadata,
    'desktop-update-manifest.json',
  ])
  const manifestPath = join(directory, 'desktop-update-manifest.json')
  if (statSync(manifestPath).size > MAX_MANIFEST_SIZE) throw new Error('desktop manifest is too large')
  const bytes = readFileSync(manifestPath)
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(MANIFEST_KEYS)) {
    throw new Error('desktop manifest fields are invalid')
  }
  if (!isRecord(value.blockmap)
    || JSON.stringify(Object.keys(value.blockmap).sort()) !== JSON.stringify(FILE_KEYS)) {
    throw new Error('desktop blockmap fields are invalid')
  }
  const manifest = value as unknown as DesktopUpdateManifest
  const canonical = desktopManifest(manifest)
  if (!bytes.equals(renderDesktopManifest(canonical))) throw new Error('desktop manifest bytes are not canonical')
  if (manifest.version !== expected.version
    || manifest.channel !== expected.channel
    || manifest.sourceCommit !== expected.sourceCommit) {
    throw new Error('desktop manifest provenance disagrees with release inputs')
  }
  const installer = measureFile(directory, names.installer)
  const blockmap = measureFile(directory, names.blockmap)
  if (!sameReleaseFile(manifest, installer) || !sameReleaseFile(manifest.blockmap, blockmap)) {
    throw new Error('desktop release files do not match their manifest')
  }
  validateUpdateMetadata(directory, names.metadata, expected.version, installer)
  return { bytes, manifest }
}

/** Validate one release file record. */
function validateReleaseFile(file: DesktopReleaseFile, label: string): void {
  if (basename(file.asset) !== file.asset || file.asset === '' || file.asset.includes('\\')) {
    throw new Error(`desktop ${label} asset name is invalid`)
  }
  if (!Number.isInteger(file.size) || file.size < 1 || !SHA_256.test(file.sha256)) {
    throw new Error(`desktop ${label} metadata is invalid`)
  }
}

/** Require a directory to contain exactly the expected regular files. */
function assertExactFiles(directory: string, expected: readonly string[]): void {
  const actual = readdirSync(directory).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error('desktop release directory contains missing or unexpected files')
  }
  for (const name of actual) {
    const info = lstatSync(join(directory, name))
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`desktop release entry is not a regular file: ${name}`)
  }
}

/** Measure one regular release file. */
function measureFile(directory: string, asset: string): DesktopReleaseFile {
  const filename = join(directory, asset)
  const info = lstatSync(filename)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`desktop release asset is not a regular file: ${asset}`)
  const maximum = asset.endsWith('.blockmap') ? MAX_BLOCKMAP_SIZE : MAX_INSTALLER_SIZE
  if (info.size > maximum) throw new Error(`desktop release asset exceeds its size limit: ${asset}`)
  return {
    asset,
    size: info.size,
    sha256: createHash('sha256').update(readFileSync(filename)).digest('hex'),
  }
}

/** Compare manifest and measured file data. */
function sameReleaseFile(left: DesktopReleaseFile, right: DesktopReleaseFile): boolean {
  return left.asset === right.asset && left.size === right.size && left.sha256 === right.sha256
}

/** Validate that electron-updater metadata names the measured installer bytes. */
function validateUpdateMetadata(
  directory: string,
  metadataName: string,
  version: string,
  installer: DesktopReleaseFile,
): void {
  const metadataPath = join(directory, metadataName)
  if (statSync(metadataPath).size > MAX_METADATA_SIZE) throw new Error('desktop update metadata is too large')
  const metadata = readFileSync(metadataPath, 'utf8').replaceAll('\r\n', '\n')
  const escapedVersion = escapeRegExp(version)
  const escapedAsset = escapeRegExp(installer.asset)
  if (!new RegExp(`^version: ["']?${escapedVersion}["']?$`, 'm').test(metadata)) {
    throw new Error('desktop update metadata version is invalid')
  }
  const urls = [...metadata.matchAll(/^\s*-?\s*url:\s*["']?([^"'\r\n]+)["']?\s*$/gm)]
    .map(match => match[1]?.trim())
  if (urls.length !== 1 || urls[0] !== installer.asset || !new RegExp(`url:\\s*["']?${escapedAsset}`).test(metadata)) {
    throw new Error('desktop update metadata installer is invalid')
  }
  const sha512 = createHash('sha512').update(readFileSync(join(directory, installer.asset))).digest('base64')
  if (!metadata.includes(`sha512: ${sha512}`) || !metadata.includes(`size: ${installer.size}`)) {
    throw new Error('desktop update metadata digest is invalid')
  }
}

/** Escape a literal for one generated regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Test an unknown JSON value for an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
