import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_RUNTIME_STATE,
  commitPendingRuntime,
  isRuntimeCompatible,
  parseRuntimeManifest,
  recordPendingFailure,
  rollbackRuntime,
  runtimeId,
  stageRuntime,
  verifyManifestSignature,
} from '../src/runtime-model.ts'

function signedManifest(): { bytes: Buffer; signature: string; publicKey: string } {
  const keys = generateKeyPairSync('ed25519')
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    harnessVersion: '0.1.0-rc.5',
    runtimeRevision: 2,
    platform: 'win32',
    arch: 'x64',
    asset: 'runtime.zip',
    size: 42,
    sha256: 'a'.repeat(64),
    commitSha: 'b'.repeat(40),
    nodeVersion: 'v24.19.0',
    minDesktopVersion: '1.0.0',
    desktopProtocolVersion: 1,
    publishedAt: '2026-08-15T00:00:00.000Z',
  }, null, 2)}\n`)
  return {
    bytes,
    signature: sign(null, bytes, keys.privateKey).toString('base64'),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

describe('desktop runtime model', () => {
  it('verifies exact signed bytes before parsing a release', () => {
    const fixture = signedManifest()
    expect(() => {
      verifyManifestSignature(fixture.bytes, fixture.signature, fixture.publicKey)
    }).not.toThrow()
    const manifest = parseRuntimeManifest(fixture.bytes)
    expect(runtimeId(manifest)).toBe('0.1.0-rc.5-r2')
    expect(isRuntimeCompatible(manifest, '1.0.0', 1)).toBe(true)

    fixture.bytes[0] = 0x20
    expect(() => {
      verifyManifestSignature(fixture.bytes, fixture.signature, fixture.publicKey)
    }).toThrow('invalid')
  })

  it('keeps the working runtime active until a pending candidate is committed', () => {
    const active = { ...EMPTY_RUNTIME_STATE, active: '0.1.0-r1' }
    const staged = stageRuntime(active, '0.2.0-r1')
    expect(staged).toMatchObject({ active: '0.1.0-r1', pending: '0.2.0-r1', previous: null })
    expect(recordPendingFailure(staged, 2)).toMatchObject({ pending: '0.2.0-r1', pendingFailures: 1 })
    expect(recordPendingFailure(recordPendingFailure(staged, 2), 2)).toMatchObject({
      active: '0.1.0-r1',
      pending: null,
      pendingFailures: 0,
    })

    const committed = commitPendingRuntime(staged)
    expect(committed).toMatchObject({ active: '0.2.0-r1', previous: '0.1.0-r1', pending: null })
    expect(rollbackRuntime(committed)).toMatchObject({ active: '0.1.0-r1', previous: '0.2.0-r1' })
  })
})
