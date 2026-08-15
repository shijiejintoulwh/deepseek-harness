/** Generate the Ed25519 key pair used to sign desktop runtime manifests. */

import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from '../release/process.ts'

/** Paths produced by the signing-key generator. */
export interface SigningKeyPaths {
  /** PKCS#8 private key; never commit this file. */
  readonly privateKey: string
  /** SPKI public key embedded in the desktop branch. */
  readonly publicKey: string
}

/**
 * Generate one Ed25519 pair into an absent or empty caller-owned directory.
 * Existing key files are never replaced.
 * @param directory - output directory.
 * @returns Written key paths.
 */
export function generateSigningKey(directory: string): SigningKeyPaths {
  const output = resolve(directory)
  mkdirSync(output, { recursive: true, mode: 0o700 })
  const privateKey = resolve(output, 'runtime-signing-private.pem')
  const publicKey = resolve(output, 'runtime-signing-public.pem')
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
    options: { out: { type: 'string', default: '.desktop-local/runtime-signing' } },
    allowPositionals: false,
  })
  const paths = generateSigningKey(values.out)
  console.log(`runtime signing private key: ${paths.privateKey}`)
  console.log(`runtime signing public key: ${paths.publicKey}`)
}

if (isEntry(import.meta.url)) main()
