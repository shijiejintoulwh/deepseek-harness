/** Generate the strict unsigned desktop update manifest from built release files. */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from '../release/process.ts'
import { generateDesktopManifest } from './manifest.ts'

/** Generate one manifest from command-line inputs. */
function main(): void {
  const { values } = parseArgs({
    args: process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2),
    options: {
      directory: { type: 'string', default: 'dist-desktop/release' },
      version: { type: 'string' },
      'source-commit': { type: 'string' },
      'published-at': { type: 'string', default: new Date().toISOString() },
    },
    allowPositionals: false,
  })
  if (values.version === undefined || values.version === '') throw new Error('--version is required')
  if (values['source-commit'] === undefined || values['source-commit'] === '') {
    throw new Error('--source-commit is required')
  }
  const directory = resolve(values.directory)
  generateDesktopManifest(directory, values.version, values['source-commit'], values['published-at'])
  console.log(`desktop update manifest: ${resolve(directory, 'desktop-update-manifest.json')}`)
}

if (isEntry(import.meta.url)) main()
