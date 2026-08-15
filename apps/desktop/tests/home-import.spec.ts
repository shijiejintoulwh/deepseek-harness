import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importHarnessHome, importHarnessHomeWithBackup, pathExists } from '../src/home-import.ts'

describe('desktop Harness home import', () => {
  it('copies an existing home without modifying the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-home-import-'))
    const source = join(root, 'source')
    const destination = join(root, 'desktop', 'dsh-home')
    await mkdir(join(source, 'profiles'), { recursive: true })
    await writeFile(join(source, 'settings.yaml'), 'theme: dark\n')
    await writeFile(join(source, 'profiles', 'web.yml'), 'version: 1\n')

    await importHarnessHome(source, destination)

    expect(await readFile(join(destination, 'settings.yaml'), 'utf8')).toBe('theme: dark\n')
    expect(await readFile(join(destination, 'profiles', 'web.yml'), 'utf8')).toBe('version: 1\n')
    expect(await readFile(join(source, 'settings.yaml'), 'utf8')).toBe('theme: dark\n')
  })

  it('skips node_modules without following its package-manager junctions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-home-dependencies-'))
    const source = join(root, 'source')
    const destination = join(root, 'desktop', 'dsh-home')
    const externalSdk = join(root, 'npm-cache', '@anthropic-ai', 'sdk')
    await mkdir(join(source, 'profiles', 'node_modules', '@anthropic-ai'), { recursive: true })
    await mkdir(externalSdk, { recursive: true })
    await writeFile(join(source, 'profiles', 'package.json'), '{"private":true}\n')
    await writeFile(join(externalSdk, 'package.json'), '{"name":"@anthropic-ai/sdk"}\n')
    await symlink(
      externalSdk,
      join(source, 'profiles', 'node_modules', '@anthropic-ai', 'sdk'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await importHarnessHome(source, destination)

    expect(await readFile(join(destination, 'profiles', 'package.json'), 'utf8')).toBe('{"private":true}\n')
    expect(await pathExists(join(destination, 'profiles', 'node_modules'))).toBe(false)
    expect(await readFile(join(externalSdk, 'package.json'), 'utf8')).toBe('{"name":"@anthropic-ai/sdk"}\n')
  })

  it('replaces an empty desktop home left by an interrupted first run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-home-empty-'))
    const source = join(root, 'source')
    const destination = join(root, 'desktop', 'dsh-home')
    await mkdir(source)
    await mkdir(destination, { recursive: true })
    await writeFile(join(source, 'settings.yaml'), 'theme: dark\n')

    await importHarnessHome(source, destination)

    expect(await readFile(join(destination, 'settings.yaml'), 'utf8')).toBe('theme: dark\n')
  })

  it('never merges into a non-empty desktop home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-home-existing-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    await mkdir(source)
    await mkdir(destination)
    await writeFile(join(destination, 'desktop-only.yaml'), 'keep: true\n')
    await expect(importHarnessHome(source, destination)).rejects.toThrow('already exists')
    expect(await readFile(join(destination, 'desktop-only.yaml'), 'utf8')).toBe('keep: true\n')
  })

  it('preserves a non-empty desktop home before an explicitly requested import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-home-backup-'))
    const source = join(root, 'source')
    const destination = join(root, 'desktop', 'dsh-home')
    await mkdir(source)
    await mkdir(destination, { recursive: true })
    await writeFile(join(source, 'settings.yaml'), 'imported: true\n')
    await writeFile(join(destination, 'desktop-only.yaml'), 'keep: true\n')

    const backup = await importHarnessHomeWithBackup(source, destination)

    if (backup === null) throw new Error('occupied desktop home did not produce a backup')
    expect(await readFile(join(destination, 'settings.yaml'), 'utf8')).toBe('imported: true\n')
    expect(await readFile(join(backup, 'desktop-only.yaml'), 'utf8')).toBe('keep: true\n')
  })

  it('restores a non-empty desktop home when the replacement import fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-home-backup-restore-'))
    const source = join(root, 'source')
    const destination = join(root, 'desktop', 'dsh-home')
    const external = join(root, 'external-config')
    await mkdir(source)
    await mkdir(destination, { recursive: true })
    await mkdir(external)
    await writeFile(join(destination, 'desktop-only.yaml'), 'keep: true\n')
    await symlink(external, join(source, 'linked-config'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(importHarnessHomeWithBackup(source, destination)).rejects.toThrow('refuses link-shaped entry')

    expect(await readFile(join(destination, 'desktop-only.yaml'), 'utf8')).toBe('keep: true\n')
    expect((await readdir(join(root, 'desktop'))).filter(name => name.includes('.backup-'))).toEqual([])
  })

  it('rejects links outside node_modules and removes its staging tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-home-link-'))
    const source = join(root, 'source')
    const destination = join(root, 'desktop', 'dsh-home')
    const external = join(root, 'external-config')
    await mkdir(source)
    await mkdir(external)
    await writeFile(join(external, 'settings.yaml'), 'secret: external\n')
    await symlink(external, join(source, 'linked-config'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(importHarnessHome(source, destination)).rejects.toThrow('refuses link-shaped entry')

    expect(await pathExists(destination)).toBe(false)
    expect((await readdir(join(root, 'desktop'))).filter(name => name.startsWith('.dsh-home-import-'))).toEqual([])
    expect(await readFile(join(external, 'settings.yaml'), 'utf8')).toBe('secret: external\n')
  })
})
