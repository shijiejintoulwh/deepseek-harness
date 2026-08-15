/** Runtime manifest construction and detached Ed25519 signing for release CI. */

import { createPrivateKey, sign } from 'node:crypto'

/** Inputs that release tooling measures or receives from reviewed configuration. */
export interface RuntimeManifestInput {
  readonly harnessVersion: string
  readonly runtimeRevision: number
  readonly asset: string
  readonly size: number
  readonly sha256: string
  readonly commitSha: string
  readonly nodeVersion: string
  readonly minDesktopVersion: string
  readonly desktopProtocolVersion: number
  readonly publishedAt: string
}

/** JSON fields signed for one Windows x64 runtime. */
export interface ReleaseRuntimeManifest extends RuntimeManifestInput {
  readonly schemaVersion: 1
  readonly platform: 'win32'
  readonly arch: 'x64'
}

/**
 * Build the canonical insertion-ordered manifest object.
 * @param input - measured release fields.
 * @returns Complete manifest.
 */
export function runtimeManifest(input: RuntimeManifestInput): ReleaseRuntimeManifest {
  if (!Number.isInteger(input.runtimeRevision) || input.runtimeRevision < 1) {
    throw new Error('runtime revision must be a positive integer')
  }
  if (!Number.isInteger(input.size) || input.size < 1) throw new Error('runtime archive size must be positive')
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error('runtime archive SHA-256 is invalid')
  if (!/^[0-9a-f]{40}$/.test(input.commitSha)) throw new Error('runtime commit SHA is invalid')
  return {
    schemaVersion: 1,
    harnessVersion: input.harnessVersion,
    runtimeRevision: input.runtimeRevision,
    platform: 'win32',
    arch: 'x64',
    asset: input.asset,
    size: input.size,
    sha256: input.sha256,
    commitSha: input.commitSha,
    nodeVersion: input.nodeVersion,
    minDesktopVersion: input.minDesktopVersion,
    desktopProtocolVersion: input.desktopProtocolVersion,
    publishedAt: input.publishedAt,
  }
}

/**
 * Render exact bytes consumed and signed by the desktop updater.
 * @param manifest - complete manifest.
 * @returns UTF-8 JSON with one trailing newline.
 */
export function renderRuntimeManifest(manifest: ReleaseRuntimeManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * Sign exact manifest bytes with an Ed25519 PKCS#8 PEM private key.
 * @param bytes - rendered manifest bytes.
 * @param privateKeyPem - release signing key.
 * @returns Base64 detached signature with one trailing newline.
 */
export function signRuntimeManifest(bytes: Buffer, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('runtime signing key must be Ed25519')
  return `${sign(null, bytes, key).toString('base64')}\n`
}
