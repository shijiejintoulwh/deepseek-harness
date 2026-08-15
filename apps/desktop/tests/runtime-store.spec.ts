import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { assertSafeArchiveEntry, RuntimeStore } from '../src/runtime-store.ts'

async function releaseBundle(root: string, entries?: Record<string, Uint8Array>): Promise<{
  publicKey: string
  manifestBytes: Buffer
  signatureText: string
  archivePath: string
}> {
  const archiveBytes = Buffer.from(zipSync(entries ?? {
    'node/node.exe': Buffer.from('node'),
    'app/lib/bin.js': Buffer.from('bin'),
  }))
  const archivePath = join(root, 'runtime.zip')
  await writeFile(archivePath, archiveBytes)
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    harnessVersion: '1.2.3',
    runtimeRevision: 1,
    platform: 'win32',
    arch: 'x64',
    asset: 'runtime.zip',
    size: archiveBytes.byteLength,
    sha256: createHash('sha256').update(archiveBytes).digest('hex'),
    commitSha: 'c'.repeat(40),
    nodeVersion: 'v24.19.0',
    minDesktopVersion: '1.0.0',
    desktopProtocolVersion: 1,
    publishedAt: '2026-08-15T00:00:00.000Z',
  }, null, 2)}\n`)
  const keys = generateKeyPairSync('ed25519')
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    manifestBytes,
    signatureText: sign(null, manifestBytes, keys.privateKey).toString('base64'),
    archivePath,
  }
}

describe('desktop runtime store', () => {
  it('installs verified ZIP contents into an immutable version directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-store-'))
    const bundle = await releaseBundle(root)
    const store = new RuntimeStore(join(root, 'store'), bundle.publicKey)
    const installed = await store.install(bundle)

    expect(installed.id).toBe('1.2.3-r1')
    expect(await readFile(join(store.runtimeDirectory(installed.id), 'app', 'lib', 'bin.js'), 'utf8')).toBe('bin')
    expect((await store.readInstalledManifest(installed.id)).sha256).toHaveLength(64)
  })

  it('rejects traversal names before extraction', () => {
    expect(() => {
      assertSafeArchiveEntry('../outside')
    }).toThrow('unsafe')
    expect(() => {
      assertSafeArchiveEntry('C:\\outside')
    }).toThrow('unsafe')
    expect(() => {
      assertSafeArchiveEntry('./app/lib/bin.js')
    }).toThrow('unsafe')
    expect(() => {
      assertSafeArchiveEntry('app/lib/bin.js')
    }).not.toThrow()
  })

  it('rejects an archive whose bytes disagree with signed metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-store-tamper-'))
    const bundle = await releaseBundle(root)
    await writeFile(bundle.archivePath, Buffer.from('tampered'))
    const store = new RuntimeStore(join(root, 'store'), bundle.publicKey)
    await expect(store.install(bundle)).rejects.toThrow('size')
  })
})
