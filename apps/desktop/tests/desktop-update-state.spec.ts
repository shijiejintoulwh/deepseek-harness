import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readInstalledShellManifestSha256,
  writeInstalledShellIdentity,
} from '../src/desktop-update-state.ts'
import type { AvailableShellUpdate } from '../src/shell-updater.ts'

describe('desktop shell identity state', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'desktop-shell-identity-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('records and returns the digest only for the running version', async () => {
    const path = join(root, 'state', 'installed-shell.json')
    const release = {
      manifest: { version: '1.2.0' },
      manifestSha256: 'a'.repeat(64),
    } as AvailableShellUpdate

    await writeInstalledShellIdentity(path, release)

    await expect(readInstalledShellManifestSha256(path, '1.2.0')).resolves.toBe('a'.repeat(64))
    await expect(readInstalledShellManifestSha256(path, '1.1.0')).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      version: '1.2.0',
      manifestSha256: 'a'.repeat(64),
    })
  })

  it('accepts absence for a manual or first migration install', async () => {
    await expect(readInstalledShellManifestSha256(join(root, 'missing.json'), '1.2.0'))
      .resolves.toBeUndefined()
  })

  it('rejects malformed durable identity instead of dropping immutability state', async () => {
    const path = join(root, 'malformed', 'installed-shell.json')
    await mkdir(join(root, 'malformed'))
    await writeFile(path, '{"version":"1.2.0"}\n')

    await expect(readInstalledShellManifestSha256(path, '1.2.0')).rejects.toThrow()
  })
})
