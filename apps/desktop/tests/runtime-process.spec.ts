import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchRuntime } from '../src/runtime-process.ts'

async function fakeRuntime(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-process-'))
  await mkdir(join(root, 'node'), { recursive: true })
  await mkdir(join(root, 'app', 'lib'), { recursive: true })
  await copyFile(process.execPath, join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node'))
  await writeFile(join(root, 'app', 'lib', 'bin.js'), `
const http = require('node:http')
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<script>window.__DSH_BOOT__={}</script>')
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  console.log('dsh web: http://127.0.0.1:' + address.port + '/')
})
`, 'utf8')
  return root
}

describe('desktop runtime process', () => {
  it('waits for the real loopback Web shell and reaches quiescence on stop', async () => {
    const root = await fakeRuntime()
    const runtime = await launchRuntime({
      runtimeDirectory: root,
      harnessHome: join(root, 'home'),
      agentsHome: join(root, 'agents'),
      timeoutMs: 10_000,
    })
    expect(new URL(runtime.url).hostname).toBe('127.0.0.1')
    await runtime.stop()
    await expect(runtime.done).resolves.toMatchObject({ error: null })
  })
})
