/** Durable identity of a desktop shell installed through the in-app updater. */

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { AvailableShellUpdate } from './shell-updater.ts'

const installedShellSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string(),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

/** Persisted identity needed to detect same-version manifest replacement. */
export type InstalledShellIdentity = z.infer<typeof installedShellSchema>

/** Whether a read error means this desktop predates shell identity state. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Read the signed-manifest digest for the running desktop version.
 * @param path - private desktop state file.
 * @param currentVersion - Electron host version currently executing.
 * @returns Digest for this exact version, or undefined for a manual or first migration install.
 */
export async function readInstalledShellManifestSha256(
  path: string,
  currentVersion: string,
): Promise<string | undefined> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
  const identity = installedShellSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown)
  return identity.version === currentVersion ? identity.manifestSha256 : undefined
}

/**
 * Record the exact manifest accepted immediately before the NSIS handoff.
 * @param path - private desktop state file.
 * @param release - verified release being installed.
 */
export async function writeInstalledShellIdentity(path: string, release: AvailableShellUpdate): Promise<void> {
  const identity: InstalledShellIdentity = {
    schemaVersion: 1,
    version: release.manifest.version,
    manifestSha256: release.manifestSha256,
  }
  await writeFileAtomic(path, `${JSON.stringify(identity)}\n`, { mode: 0o600, dirMode: 0o700 })
}
