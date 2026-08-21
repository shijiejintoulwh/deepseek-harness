/** Generate the independent Ed25519 key pair used for desktop update manifests. */

import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from '../release/process.ts'

/** Paths produced by the desktop update signing-key generator. */
export interface DesktopSigningKeyPaths {
  /** PKCS#8 private key for the protected desktop-release environment. */
  readonly privateKey: string
  /** SPKI public key embedded in the desktop shell. */
  readonly publicKey: string
}

/**
 * Generate one Ed25519 pair without replacing existing key files.
 * @param directory - Caller-owned output directory.
 * @returns Written private and public key paths.
 */
export function generateDesktopSigningKey(directory: string): DesktopSigningKeyPaths {
  const output = resolve(directory)
  mkdirSync(output, { recursive: true, mode: 0o700 })
  const privateKey = resolve(output, 'desktop-update-private.pem')
  const publicKey = resolve(output, 'desktop-update-public.pem')
  const pair = generateKeyPairSync('ed25519')
  writeFileSync(privateKey, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    flag: 'wx',
    mode: 0o600,
  })
  writeFileSync(publicKey, pair.publicKey.export({ type: 'spki', format: 'pem' }), {
    flag: 'wx',
    mode: 0o644,
  })
  return { privateKey, publicKey }
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2),
    options: { out: { type: 'string', default: '.desktop-local/shell-signing' } },
    allowPositionals: false,
  })
  const paths = generateDesktopSigningKey(values.out)
  console.log(`desktop update signing private key: ${paths.privateKey}`)
  console.log(`desktop update signing public key: ${paths.publicKey}`)
}

if (isEntry(import.meta.url)) main()
