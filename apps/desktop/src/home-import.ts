/**
 * One-time Harness home import. The desktop copy is built in a random sibling,
 * omits rebuildable dependency trees, rejects every other link or junction,
 * then becomes visible through one rename; the source is never modified.
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rename, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isMissingFilesystemError, removeTreeNoFollow } from './safe-fs.ts'

/** Retry the short Windows sharing violation seen after a sibling rename. */
async function renameDirectory(source: string, destination: string): Promise<void> {
  const delays = [50, 100, 200, 400, 800]
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      const retryable = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')
      const wait = delays[attempt]
      if (!retryable || wait === undefined) throw error
      await delay(wait)
    }
  }
}

/**
 * Resolve the existing CLI Harness home considered for first-run import.
 * @param environment - launch environment captured before desktop overrides.
 * @returns Absolute legacy home path.
 */
export function legacyHarnessHome(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.DSH_HOME ?? join(homedir(), '.dsh'))
}

/**
 * Check whether a path exists without swallowing non-missing errors.
 * @param path - candidate path.
 * @returns True when the path exists.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissingFilesystemError(error)) return false
    throw error
  }
}

/** Whether an absent or empty real directory is safe to replace by an import. */
export async function canImportHarnessHome(destination: string): Promise<boolean> {
  try {
    const info = await lstat(destination)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    return (await readdir(destination)).length === 0
  } catch (error) {
    if (isMissingFilesystemError(error)) return true
    throw error
  }
}

/** Whether a non-empty real directory may be preserved before an import. */
export async function canBackupHarnessHome(destination: string): Promise<boolean> {
  try {
    const info = await lstat(destination)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    return (await readdir(destination)).length > 0
  } catch (error) {
    if (isMissingFilesystemError(error)) return false
    throw error
  }
}

/** Remove an absent-or-empty import target immediately before atomic rename. */
async function removeEmptyDestinationIfPresent(destination: string): Promise<void> {
  try {
    const info = await lstat(destination)
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(destination)).length !== 0) {
      throw new Error(`desktop Harness home already exists: ${destination}`)
    }
    await rmdir(destination)
  } catch (error) {
    if (isMissingFilesystemError(error)) return
    throw error
  }
}

/** Copy one importable directory tree into a newly created destination. */
async function copyTree(source: string, destination: string): Promise<void> {
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Harness home import source is not a real directory: ${source}`)
  }
  await mkdir(destination, { mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    // Installed dependencies are derived from profile manifests and routinely
    // contain pnpm/npm junctions that must neither be followed nor imported.
    if (entry.name === 'node_modules') continue
    const sourceEntry = join(source, entry.name)
    const destinationEntry = join(destination, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Harness home import refuses link-shaped entry: ${sourceEntry}`)
    }
    if (entry.isDirectory()) {
      await copyTree(sourceEntry, destinationEntry)
      continue
    }
    if (!entry.isFile()) throw new Error(`Harness home import refuses non-file entry: ${sourceEntry}`)
    await copyFile(sourceEntry, destinationEntry, constants.COPYFILE_EXCL)
  }
}

/**
 * Copy an existing Harness home into an absent or empty desktop-owned home.
 * @param source - existing CLI home.
 * @param destination - absent or empty desktop home.
 */
export async function importHarnessHome(source: string, destination: string): Promise<void> {
  const absoluteSource = resolve(source)
  const absoluteDestination = resolve(destination)
  if (absoluteSource === absoluteDestination) throw new Error('desktop Harness home must differ from the import source')
  if (!await canImportHarnessHome(absoluteDestination)) {
    throw new Error(`desktop Harness home already exists: ${absoluteDestination}`)
  }

  const parent = dirname(absoluteDestination)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const staging = join(parent, `.dsh-home-import-${randomBytes(6).toString('hex')}`)
  try {
    await copyTree(absoluteSource, staging)
    await removeEmptyDestinationIfPresent(absoluteDestination)
    await renameDirectory(staging, absoluteDestination)
  } catch (error) {
    await removeTreeNoFollow(parent, staging)
    throw error
  }
}

/**
 * Import while preserving an occupied desktop home as a random sibling.
 * A failed import restores the original directory before returning the error.
 * @returns Backup path, or null when no existing data needed preservation.
 */
export async function importHarnessHomeWithBackup(source: string, destination: string): Promise<string | null> {
  const absoluteDestination = resolve(destination)
  if (await canImportHarnessHome(absoluteDestination)) {
    await importHarnessHome(source, absoluteDestination)
    return null
  }
  if (!await canBackupHarnessHome(absoluteDestination)) {
    throw new Error(`desktop Harness home cannot be backed up safely: ${absoluteDestination}`)
  }

  const backup = `${absoluteDestination}.backup-${randomBytes(6).toString('hex')}`
  await renameDirectory(absoluteDestination, backup)
  try {
    await importHarnessHome(source, absoluteDestination)
    return backup
  } catch (error) {
    try {
      await renameDirectory(backup, absoluteDestination)
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Harness home import failed and its backup could not be restored: ${absoluteDestination}`,
      )
    }
    throw error
  }
}
