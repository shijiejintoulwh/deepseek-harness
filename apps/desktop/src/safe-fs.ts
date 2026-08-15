/**
 * Destructive filesystem helpers for desktop-owned trees. Recursive removal
 * inspects each entry with lstat and unlinks reparse points instead of following
 * them into user-controlled locations.
 */

import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Whether a filesystem error reports an absent path. */
export function isMissingFilesystemError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Ensure a destructive target is a strict child of its caller-owned root. */
function assertOwnedChild(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`desktop-owned path escapes its root: ${candidate}`)
  }
}

/** Remove one owned tree without traversing symbolic links or junctions. */
export async function removeTreeNoFollow(root: string, target: string): Promise<void> {
  assertOwnedChild(root, target)
  let info
  try {
    info = await lstat(target)
  } catch (error) {
    if (isMissingFilesystemError(error)) return
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    await unlink(target)
    return
  }
  for (const name of await readdir(target)) {
    await removeTreeNoFollow(root, resolve(target, name))
  }
  await rmdir(target)
}
