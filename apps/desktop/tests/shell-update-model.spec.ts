import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  evaluateShellUpdate,
  parseShellUpdateManifest,
  shellManifestSha256,
  verifyShellUpdateFile,
  verifyShellUpdateManifestSignature,
} from '../src/shell-update-model.ts'

const temporaryDirectories: string[] = []

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: '1.1.0-preview.1',
    channel: 'preview',
    platform: 'win32',
    arch: 'x64',
    asset: 'DeepSeek-Harness-Desktop-1.1.0-preview.1-win-x64.exe',
    size: 12,
    sha256: 'a'.repeat(64),
    blockmap: {
      asset: 'DeepSeek-Harness-Desktop-1.1.0-preview.1-win-x64.exe.blockmap',
      size: 6,
      sha256: 'b'.repeat(64),
    },
    sourceCommit: 'c'.repeat(40),
    publishedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('desktop shell update model', () => {
  it('verifies exact manifest bytes with the dedicated Ed25519 key', () => {
    const desktopKeys = generateKeyPairSync('ed25519')
    const runtimeKeys = generateKeyPairSync('ed25519')
    const bytes = Buffer.from(`${JSON.stringify(manifest())}\n`)
    const signature = sign(null, bytes, desktopKeys.privateKey).toString('base64')

    expect(() => {
      verifyShellUpdateManifestSignature(
        bytes,
        signature,
        desktopKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      )
    }).not.toThrow()
    expect(() => {
      verifyShellUpdateManifestSignature(
        bytes,
        signature,
        runtimeKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      )
    }).toThrow('invalid')
    expect(shellManifestSha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('strictly binds every installer and blockmap field', () => {
    const parsed = parseShellUpdateManifest(Buffer.from(JSON.stringify(manifest())))
    expect(parsed.blockmap.asset).toMatch(/\.blockmap$/)
    expect(() => parseShellUpdateManifest(Buffer.from(JSON.stringify(manifest({ extra: true }))))).toThrow()
    expect(() => parseShellUpdateManifest(Buffer.from(JSON.stringify(manifest({
      channel: 'stable',
    }))))).toThrow('channel')
    expect(() => parseShellUpdateManifest(Buffer.from(JSON.stringify(manifest({
      blockmap: { ...parsed.blockmap, unknown: true },
    }))))).toThrow()
  })

  it('keeps stable and preview channels forward-only', () => {
    const preview = parseShellUpdateManifest(Buffer.from(JSON.stringify(manifest())))
    const stable = parseShellUpdateManifest(Buffer.from(JSON.stringify(manifest({
      version: '1.1.0',
      channel: 'stable',
    }))))

    expect(evaluateShellUpdate(preview, {
      version: '1.0.0', channel: 'stable', platform: 'win32', arch: 'x64',
    })).toEqual({ kind: 'incompatible', reason: 'channel' })
    expect(evaluateShellUpdate(preview, {
      version: '1.0.0-preview.1', channel: 'preview', platform: 'win32', arch: 'x64',
    })).toEqual({ kind: 'newer' })
    expect(evaluateShellUpdate(stable, {
      version: '1.1.0-preview.2', channel: 'preview', platform: 'win32', arch: 'x64',
    })).toEqual({ kind: 'newer' })
    expect(evaluateShellUpdate(stable, {
      version: '1.2.0-preview.1', channel: 'preview', platform: 'win32', arch: 'x64',
    })).toEqual({ kind: 'older' })
  })

  it('checks exact downloaded bytes and honours cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-shell-model-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'installer.exe')
    const bytes = Buffer.from('installer bytes')
    await writeFile(path, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')

    await expect(verifyShellUpdateFile(path, bytes.length, digest, new AbortController().signal)).resolves.toBeUndefined()
    await expect(verifyShellUpdateFile(path, bytes.length + 1, digest, new AbortController().signal)).rejects.toThrow('ended')
    await expect(verifyShellUpdateFile(path, bytes.length, '0'.repeat(64), new AbortController().signal)).rejects.toThrow('SHA-256')

    const controller = new AbortController()
    controller.abort()
    await expect(verifyShellUpdateFile(path, bytes.length, digest, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
