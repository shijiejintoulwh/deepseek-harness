import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateDesktopSigningKey } from './generate-signing-key.ts'
import {
  desktopReleaseChannel,
  desktopReleaseNames,
  generateDesktopManifest,
  signDesktopManifest,
  validateUnsignedDesktopRelease,
} from './manifest.ts'

const SOURCE_COMMIT = 'c'.repeat(40)
const PUBLISHED_AT = '2026-08-21T00:00:00.000Z'

describe('desktop shell release manifest', () => {
  it('binds preview installer, blockmap, metadata, source, and tag before signing', () => {
    const fixture = desktopFixture('1.0.5-preview.1')
    const keys = generateKeyPairSync('ed25519')
    try {
      const manifest = generateDesktopManifest(fixture.directory, fixture.version, SOURCE_COMMIT, PUBLISHED_AT)
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        version: fixture.version,
        channel: 'preview',
        platform: 'win32',
        arch: 'x64',
        asset: fixture.names.installer,
        blockmap: { asset: fixture.names.blockmap },
        sourceCommit: SOURCE_COMMIT,
        publishedAt: PUBLISHED_AT,
      })
      const validated = validateUnsignedDesktopRelease(fixture.directory, {
        version: fixture.version,
        tag: `desktop-v${fixture.version}`,
        channel: 'preview',
        sourceCommit: SOURCE_COMMIT,
      })
      const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      const signature = Buffer.from(signDesktopManifest(validated.bytes, privateKey).trim(), 'base64')
      expect(verify(null, validated.bytes, keys.publicKey, signature)).toBe(true)
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('uses latest.yml only for stable versions', () => {
    expect(desktopReleaseChannel('2.0.0')).toBe('stable')
    expect(desktopReleaseNames('2.0.0').metadata).toBe('latest.yml')
    expect(desktopReleaseNames('2.0.0-preview.3').metadata).toBe('preview.yml')
    expect(() => desktopReleaseChannel('2.0.0-beta.1')).toThrow('stable SemVer or x.y.z-preview.n')
  })

  it('keeps renamed preview.yml bytes parseable by electron-updater generic feeds', () => {
    const fixture = desktopFixture('1.0.5-preview.6')
    const requireFromDesktop = createRequire(join(import.meta.dirname, '..', '..', 'apps', 'desktop', 'package.json'))
    const provider = requireFromDesktop('electron-updater/out/providers/Provider.js') as {
      parseUpdateInfo(rawData: string, channelFile: string, channelFileUrl: URL): unknown
      resolveFiles(updateInfo: unknown, baseUrl: URL): Array<{ url: URL }>
    }
    try {
      const raw = readFileSync(join(fixture.directory, fixture.names.metadata), 'utf8')
      const base = new URL('https://github.com/shijiejintoulwh/deepseek-harness/releases/download/desktop-v1.0.5-preview.6/')
      const updateInfo = provider.parseUpdateInfo(raw, 'preview.yml', new URL('preview.yml', base))
      expect(provider.resolveFiles(updateInfo, base).map(file => file.url.href)).toEqual([
        new URL(fixture.names.installer, base).href,
      ])
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects installer tampering after manifest generation', () => {
    const fixture = desktopFixture('1.0.5-preview.2')
    try {
      generateDesktopManifest(fixture.directory, fixture.version, SOURCE_COMMIT, PUBLISHED_AT)
      writeFileSync(join(fixture.directory, fixture.names.installer), 'tampered installer')
      expect(() => validateUnsignedDesktopRelease(fixture.directory, expectations(fixture.version)))
        .toThrow('do not match their manifest')
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects a tag or source commit that disagrees with the signed provenance', () => {
    const fixture = desktopFixture('1.0.5-preview.3')
    try {
      generateDesktopManifest(fixture.directory, fixture.version, SOURCE_COMMIT, PUBLISHED_AT)
      expect(() => validateUnsignedDesktopRelease(fixture.directory, {
        ...expectations(fixture.version),
        tag: 'desktop-v1.0.5-preview.4',
      })).toThrow('tag is invalid')
      expect(() => validateUnsignedDesktopRelease(fixture.directory, {
        ...expectations(fixture.version),
        sourceCommit: 'd'.repeat(40),
      })).toThrow('provenance disagrees')
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects missing blockmaps and unexpected release entries', () => {
    const missing = desktopFixture('1.0.5-preview.4')
    try {
      unlinkSync(join(missing.directory, missing.names.blockmap))
      expect(() => generateDesktopManifest(missing.directory, missing.version, SOURCE_COMMIT, PUBLISHED_AT))
        .toThrow('missing or unexpected files')
    } finally {
      rmSync(missing.directory, { recursive: true, force: true })
    }

    const extra = desktopFixture('1.0.5-preview.5')
    try {
      writeFileSync(join(extra.directory, 'unexpected.txt'), 'must not publish')
      expect(() => generateDesktopManifest(extra.directory, extra.version, SOURCE_COMMIT, PUBLISHED_AT))
        .toThrow('missing or unexpected files')
    } finally {
      rmSync(extra.directory, { recursive: true, force: true })
    }
  })

  it('generates independent non-overwriting Ed25519 key files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-key-test-'))
    try {
      const paths = generateDesktopSigningKey(directory)
      expect(readFileSync(paths.privateKey, 'utf8')).toContain('BEGIN PRIVATE KEY')
      expect(readFileSync(paths.publicKey, 'utf8')).toContain('BEGIN PUBLIC KEY')
      expect(() => generateDesktopSigningKey(directory)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function expectations(version: string): {
  version: string
  tag: string
  channel: 'preview'
  sourceCommit: string
} {
  return { version, tag: `desktop-v${version}`, channel: 'preview', sourceCommit: SOURCE_COMMIT }
}

function desktopFixture(version: string): {
  directory: string
  version: string
  names: ReturnType<typeof desktopReleaseNames>
} {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-release-test-'))
  const names = desktopReleaseNames(version)
  mkdirSync(directory, { recursive: true })
  const installer = Buffer.from(`installer ${version}`)
  writeFileSync(join(directory, names.installer), installer)
  writeFileSync(join(directory, names.blockmap), Buffer.from(`blockmap ${version}`))
  const sha512 = createHash('sha512').update(installer).digest('base64')
  writeFileSync(join(directory, names.metadata), [
    `version: ${version}`,
    'files:',
    `  - url: ${names.installer}`,
    `    sha512: ${sha512}`,
    `    size: ${installer.length}`,
    `path: ${names.installer}`,
    `sha512: ${sha512}`,
    `releaseDate: ${PUBLISHED_AT}`,
    '',
  ].join('\n'))
  return { directory, version, names }
}
