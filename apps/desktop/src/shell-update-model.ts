/**
 * Validation and policy for signed Electron shell releases. This update plane
 * is intentionally separate from Harness runtime manifests and keys.
 */

import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { compare, prerelease, valid } from 'semver'
import { z } from 'zod'

const safeAssetName = /^[0-9A-Za-z][0-9A-Za-z._-]*$/
const sha256 = /^[0-9a-f]{64}$/
const semanticVersion = z.string().refine(value => valid(value) !== null, 'invalid semantic version')

const blockmapSchema = z.object({
  asset: z.string().regex(safeAssetName),
  size: z.number().int().positive(),
  sha256: z.string().regex(sha256),
}).strict()

/** Schema for one published Windows desktop shell. */
const shellUpdateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: semanticVersion,
  channel: z.enum(['stable', 'preview']),
  platform: z.literal('win32'),
  arch: z.literal('x64'),
  asset: z.string().regex(safeAssetName),
  size: z.number().int().positive(),
  sha256: z.string().regex(sha256),
  blockmap: blockmapSchema,
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  publishedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((manifest, context) => {
  const isPreview = prerelease(manifest.version) !== null
  if ((manifest.channel === 'preview') !== isPreview) {
    context.addIssue({
      code: 'custom',
      path: ['channel'],
      message: 'channel must agree with the semantic version prerelease marker',
    })
  }
  if (manifest.blockmap.asset === manifest.asset) {
    context.addIssue({
      code: 'custom',
      path: ['blockmap', 'asset'],
      message: 'blockmap asset must differ from the installer asset',
    })
  }
})

/** Release channels supported by the desktop shell. */
export type ShellUpdateChannel = 'stable' | 'preview'

/** Signed metadata for one desktop installer and its differential blockmap. */
export type ShellUpdateManifest = z.infer<typeof shellUpdateManifestSchema>

/** Current desktop identity used for update and immutability decisions. */
export interface CurrentShellRelease {
  /** Installed desktop semantic version. */
  readonly version: string
  /** Channel selected by the installed desktop. */
  readonly channel: ShellUpdateChannel
  /** Runtime platform identifier. */
  readonly platform: NodeJS.Platform
  /** Runtime architecture identifier. */
  readonly arch: string
  /** Signed-manifest digest embedded by the release build, when available. */
  readonly manifestSha256?: string
}

/** Reason a valid signed release cannot update the current desktop. */
export type ShellUpdateIncompatibility = 'channel' | 'platform' | 'arch'

/** Result of applying version, channel, and target policy to one release. */
export type ShellUpdatePolicyResult =
  | { readonly kind: 'newer' }
  | { readonly kind: 'current' }
  | { readonly kind: 'older' }
  | { readonly kind: 'incompatible'; readonly reason: ShellUpdateIncompatibility }

/** Parse exact manifest bytes after detached signature verification. */
export function parseShellUpdateManifest(bytes: Buffer): ShellUpdateManifest {
  const manifest = shellUpdateManifestSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown)
  return manifest
}

/**
 * Verify the desktop release signature with the dedicated shell public key.
 * @param bytes - exact manifest bytes fetched from the release.
 * @param signatureText - detached base64 Ed25519 signature.
 * @param desktopPublicKeyPem - desktop release public key embedded by the shell build.
 */
export function verifyShellUpdateManifestSignature(
  bytes: Buffer,
  signatureText: string,
  desktopPublicKeyPem: string,
): void {
  const normalized = signatureText.trim()
  if (!/^[0-9A-Za-z+/]+={0,2}$/.test(normalized)) {
    throw new Error('desktop update manifest signature is not base64')
  }
  const signature = Buffer.from(normalized, 'base64')
  const publicKey = createPublicKey(desktopPublicKeyPem)
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('desktop update manifest public key is not Ed25519')
  }
  if (signature.byteLength !== 64) {
    throw new Error('desktop update manifest signature has an invalid length')
  }
  if (!verify(null, bytes, publicKey, signature)) {
    throw new Error('desktop update manifest signature is invalid')
  }
}

/**
 * Calculate the immutable identity of exact signed manifest bytes.
 * @param bytes - exact signed manifest bytes.
 * @returns Lowercase SHA-256 digest.
 */
export function shellManifestSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Decide whether a release is a forward update for the installed channel.
 * @param candidate - verified and parsed candidate manifest.
 * @param current - installed desktop identity.
 * @returns Compatibility and semantic-version decision.
 */
export function evaluateShellUpdate(
  candidate: ShellUpdateManifest,
  current: CurrentShellRelease,
): ShellUpdatePolicyResult {
  if (candidate.platform !== current.platform) return { kind: 'incompatible', reason: 'platform' }
  if (candidate.arch !== current.arch) return { kind: 'incompatible', reason: 'arch' }
  if (current.channel === 'stable' && candidate.channel !== 'stable') {
    return { kind: 'incompatible', reason: 'channel' }
  }
  const versionOrder = compare(candidate.version, current.version)
  if (versionOrder > 0) return { kind: 'newer' }
  if (versionOrder < 0) return { kind: 'older' }
  return { kind: 'current' }
}

/**
 * Hash a downloaded asset without trusting transport metadata.
 * @param path - downloaded local file.
 * @param expectedSize - byte count committed by the signed manifest.
 * @param expectedSha256 - digest committed by the signed manifest.
 * @param signal - cancellation signal checked during streaming.
 */
export async function verifyShellUpdateFile(
  path: string,
  expectedSize: number,
  expectedSha256: string,
  signal: AbortSignal,
): Promise<void> {
  const hash = createHash('sha256')
  let size = 0
  const input = createReadStream(path)
  try {
    for await (const chunk of input) {
      if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      const bytes = chunk as Buffer
      size += bytes.byteLength
      if (size > expectedSize) throw new Error(`desktop update asset exceeds its signed size of ${expectedSize} bytes`)
      hash.update(bytes)
    }
  } finally {
    input.destroy()
  }
  if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  if (size !== expectedSize) {
    throw new Error(`desktop update asset ended at ${size} bytes; expected ${expectedSize}`)
  }
  if (hash.digest('hex') !== expectedSha256) {
    throw new Error('desktop update asset SHA-256 disagrees with its signed manifest')
  }
}
