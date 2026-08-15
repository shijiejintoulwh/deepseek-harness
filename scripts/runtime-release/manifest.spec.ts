import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseRuntimeManifest, verifyManifestSignature } from '../../apps/desktop/src/runtime-model.ts'
import { renderRuntimeManifest, runtimeManifest, signRuntimeManifest } from './manifest.ts'

describe('Windows runtime release manifest', () => {
  it('produces bytes accepted by the desktop updater', () => {
    const keys = generateKeyPairSync('ed25519')
    const manifest = runtimeManifest({
      harnessVersion: '0.1.0-rc.5',
      runtimeRevision: 3,
      asset: 'runtime.zip',
      size: 100,
      sha256: 'd'.repeat(64),
      commitSha: 'e'.repeat(40),
      nodeVersion: 'v24.19.0',
      minDesktopVersion: '1.0.0',
      desktopProtocolVersion: 1,
      publishedAt: '2026-08-15T00:00:00.000Z',
    })
    const bytes = renderRuntimeManifest(manifest)
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const signature = signRuntimeManifest(bytes, privateKey)
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

    expect(() => {
      verifyManifestSignature(bytes, signature, publicKey)
    }).not.toThrow()
    expect(parseRuntimeManifest(bytes)).toEqual(manifest)
  })
})
