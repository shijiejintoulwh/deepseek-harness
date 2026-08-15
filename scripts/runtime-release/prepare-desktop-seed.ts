/** Copy one signed runtime release set into electron-builder's ignored seed directory. */

import { constants, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from '../release/process.ts'

function main(): void {
  const { values } = parseArgs({
    args: process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2),
    options: {
      from: { type: 'string', default: 'dist-desktop/runtime' },
      to: { type: 'string', default: 'apps/desktop/build/seed-runtime' },
    },
    allowPositionals: false,
  })
  const source = resolve(values.from)
  const destination = resolve(values.to)
  const manifestText = readFileSync(join(source, 'runtime-manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestText) as { asset?: unknown }
  if (typeof manifest.asset !== 'string' || basename(manifest.asset) !== manifest.asset) {
    throw new Error('runtime seed manifest has no safe asset filename')
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const filename of ['runtime-manifest.json', 'runtime-manifest.sig', manifest.asset]) {
    copyFileSync(join(source, filename), join(destination, filename), constants.COPYFILE_EXCL)
  }
  console.log(`desktop seed runtime: ${destination}`)
}

if (isEntry(import.meta.url)) main()
