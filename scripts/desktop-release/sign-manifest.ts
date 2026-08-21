/** Validate and locally sign one desktop update release set. */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from '../release/process.ts'
import {
  signDesktopManifest,
  validateUnsignedDesktopRelease,
  type DesktopReleaseExpectations,
} from './manifest.ts'

/**
 * Validate an unsigned release set before writing its detached signature.
 * @param directory - Directory containing the exact unsigned release set.
 * @param privateKeyPath - Local Ed25519 PKCS#8 PEM path.
 * @param expected - Independently supplied release identity.
 * @returns Written signature path.
 */
export function signDesktopRelease(
  directory: string,
  privateKeyPath: string,
  expected: DesktopReleaseExpectations,
): string {
  const releaseDirectory = resolve(directory)
  const validated = validateUnsignedDesktopRelease(releaseDirectory, expected)
  const privateKeyPem = readFileSync(resolve(privateKeyPath), 'utf8')
  const signaturePath = resolve(releaseDirectory, 'desktop-update-manifest.sig')
  writeFileSync(signaturePath, signDesktopManifest(validated.bytes, privateKeyPem), {
    flag: 'wx',
    mode: 0o600,
  })
  return signaturePath
}

/** Sign one desktop release from command-line inputs without printing key material. */
function main(): void {
  const { values } = parseArgs({
    args: process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2),
    options: {
      directory: { type: 'string', default: 'dist-desktop/release' },
      'private-key': { type: 'string' },
      version: { type: 'string' },
      tag: { type: 'string' },
      channel: { type: 'string' },
      'source-commit': { type: 'string' },
    },
    allowPositionals: false,
  })
  if (values['private-key'] === undefined || values['private-key'] === '') throw new Error('--private-key is required')
  if (values.version === undefined || values.version === '') throw new Error('--version is required')
  if (values.tag === undefined || values.tag === '') throw new Error('--tag is required')
  if (values.channel !== 'stable' && values.channel !== 'preview') {
    throw new Error('--channel must be stable or preview')
  }
  if (values['source-commit'] === undefined || values['source-commit'] === '') {
    throw new Error('--source-commit is required')
  }
  const signaturePath = signDesktopRelease(values.directory, values['private-key'], {
    version: values.version,
    tag: values.tag,
    channel: values.channel,
    sourceCommit: values['source-commit'],
  })
  console.log(`desktop update signature: ${signaturePath}`)
}

if (isEntry(import.meta.url)) main()
