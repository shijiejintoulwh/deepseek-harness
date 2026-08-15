/**
 * Validation and comparison for the signed runtime manifest and local updater
 * state. Both documents cross a file or network boundary and therefore reject
 * unknown fields and invalid identifiers before any path is derived from them.
 */

import { createPublicKey, verify } from 'node:crypto'
import { compare, valid } from 'semver'
import { z } from 'zod'

const safeIdentifier = /^[0-9A-Za-z][0-9A-Za-z._-]*$/
const sha256 = /^[0-9a-f]{64}$/

/** Schema for one published self-contained Windows Harness runtime. */
const runtimeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  harnessVersion: z.string().refine(value => valid(value) !== null, 'invalid semantic version'),
  runtimeRevision: z.number().int().positive(),
  platform: z.literal('win32'),
  arch: z.literal('x64'),
  asset: z.string().regex(safeIdentifier),
  size: z.number().int().positive(),
  sha256: z.string().regex(sha256),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
  minDesktopVersion: z.string().refine(value => valid(value) !== null, 'invalid minimum desktop version'),
  desktopProtocolVersion: z.number().int().positive(),
  publishedAt: z.iso.datetime({ offset: true }),
}).strict()

/** Signed metadata for one runtime archive. */
export type RuntimeManifest = z.infer<typeof runtimeManifestSchema>

/** Schema for the atomic local runtime-selection document. */
export const runtimeStateSchema = z.object({
  schemaVersion: z.literal(1),
  active: z.string().regex(safeIdentifier).nullable(),
  previous: z.string().regex(safeIdentifier).nullable(),
  pending: z.string().regex(safeIdentifier).nullable(),
  pendingFailures: z.number().int().nonnegative(),
  skipped: z.string().regex(safeIdentifier).nullable(),
}).strict()

/** Durable selection state for installed runtime directories. */
export type RuntimeState = z.infer<typeof runtimeStateSchema>

/** Empty state used before the bundled seed runtime is installed. */
export const EMPTY_RUNTIME_STATE: RuntimeState = {
  schemaVersion: 1,
  active: null,
  previous: null,
  pending: null,
  pendingFailures: 0,
  skipped: null,
}

/**
 * Parse manifest bytes only after their detached signature has been checked.
 * @param bytes - exact bytes downloaded from the release.
 * @returns Validated runtime manifest.
 */
export function parseRuntimeManifest(bytes: Buffer): RuntimeManifest {
  return runtimeManifestSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown)
}

/**
 * Verify a detached base64 Ed25519 signature over exact manifest bytes.
 * @param bytes - exact manifest bytes.
 * @param signatureText - base64 detached signature.
 * @param publicKeyPem - trusted public key embedded in the desktop host.
 * @returns Nothing; invalid encoding or signatures throw.
 */
export function verifyManifestSignature(bytes: Buffer, signatureText: string, publicKeyPem: string): void {
  const normalized = signatureText.trim()
  if (!/^[0-9A-Za-z+/]+={0,2}$/.test(normalized)) {
    throw new Error('runtime manifest signature is not base64')
  }
  const signature = Buffer.from(normalized, 'base64')
  const publicKey = createPublicKey(publicKeyPem)
  if (!verify(null, bytes, publicKey, signature)) {
    throw new Error('runtime manifest signature is invalid')
  }
}

/**
 * Stable directory identifier derived only from validated manifest fields.
 * @param manifest - validated runtime manifest.
 * @returns Filesystem-safe runtime id.
 */
export function runtimeId(manifest: RuntimeManifest): string {
  return `${manifest.harnessVersion}-r${manifest.runtimeRevision}`
}

/**
 * Compare two releases by Harness semantic version and packaging revision.
 * @param left - first release.
 * @param right - second release.
 * @returns Negative, zero, or positive ordering value.
 */
export function compareRuntimeVersions(left: RuntimeManifest, right: RuntimeManifest): number {
  const versionOrder = compare(left.harnessVersion, right.harnessVersion)
  return versionOrder === 0 ? left.runtimeRevision - right.runtimeRevision : versionOrder
}

/**
 * Check whether this desktop host may start a runtime.
 * @param manifest - candidate runtime.
 * @param desktopVersion - current Electron host version.
 * @param protocolVersion - protocol implemented by the host.
 * @returns True only when both compatibility declarations pass.
 */
export function isRuntimeCompatible(
  manifest: RuntimeManifest,
  desktopVersion: string,
  protocolVersion: number,
): boolean {
  return compare(desktopVersion, manifest.minDesktopVersion) >= 0
    && manifest.desktopProtocolVersion === protocolVersion
}

/**
 * Select the runtime attempted on the next launch.
 * @param state - validated local state.
 * @returns Pending candidate when present, otherwise the active runtime.
 */
export function selectedRuntimeId(state: RuntimeState): string | null {
  return state.pending ?? state.active
}

/**
 * Stage an installed runtime without replacing the current working version.
 * @param state - current local state.
 * @param candidate - installed candidate id.
 * @returns Next state.
 */
export function stageRuntime(state: RuntimeState, candidate: string): RuntimeState {
  if (!safeIdentifier.test(candidate)) throw new Error(`invalid runtime id: ${candidate}`)
  if (candidate === state.active) return { ...state, pending: null, pendingFailures: 0 }
  return { ...state, pending: candidate, pendingFailures: 0, skipped: null }
}

/**
 * Commit the pending runtime after its stability interval passes.
 * @param state - state containing a pending runtime.
 * @returns State with the candidate active and the old active version retained.
 */
export function commitPendingRuntime(state: RuntimeState): RuntimeState {
  if (state.pending === null) return state
  return {
    ...state,
    active: state.pending,
    previous: state.active,
    pending: null,
    pendingFailures: 0,
  }
}

/**
 * Record one failed candidate launch and reject it at the supplied threshold.
 * @param state - current local state.
 * @param threshold - number of failures that clears the pending candidate.
 * @returns Updated failure state.
 */
export function recordPendingFailure(state: RuntimeState, threshold: number): RuntimeState {
  if (state.pending === null) return state
  const failures = state.pendingFailures + 1
  return failures >= threshold
    ? { ...state, pending: null, pendingFailures: 0 }
    : { ...state, pendingFailures: failures }
}

/**
 * Swap active and previous versions for a user-requested rollback.
 * @param state - current local state.
 * @returns Rolled-back state.
 */
export function rollbackRuntime(state: RuntimeState): RuntimeState {
  if (state.previous === null) throw new Error('no previous Harness runtime is available')
  return {
    ...state,
    active: state.previous,
    previous: state.active,
    pending: null,
    pendingFailures: 0,
  }
}
