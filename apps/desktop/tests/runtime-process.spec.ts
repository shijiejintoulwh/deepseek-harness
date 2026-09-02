import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchRuntime } from '../src/runtime-process.ts'

async function fakeRuntime(mode: 'current' | 'legacy' | 'token'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-process-'))
  await mkdir(join(root, 'node'), { recursive: true })
  await mkdir(join(root, 'app', 'lib'), { recursive: true })
  await copyFile(process.execPath, join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node'))
  await writeFile(join(root, 'app', 'lib', 'bin.js'), `
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const mode = ${JSON.stringify(mode)}
const launches = path.join(__dirname, 'launches.jsonl')
const args = process.argv.slice(2)
fs.appendFileSync(launches, JSON.stringify(args) + '\\n')
if (mode === 'legacy' && args.includes('--no-open')) {
  console.error("error: unknown option '--no-open'")
  process.exit(1)
}
const expected = ['web', '--host', '127.0.0.1', '--port', '0']
  .concat(mode === 'legacy' ? [] : ['--no-open'])
if (JSON.stringify(args) !== JSON.stringify(expected)) {
  console.error('unexpected runtime arguments: ' + JSON.stringify(args))
  process.exit(2)
}
const server = http.createServer((request, response) => {
  if (mode !== 'token') {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<script>window.__DSH_BOOT__={}</script>')
    return
  }
  if (request.headers.cookie === 'dsh_launch=test-token') {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<script>window.__DSH_BOOT__={}</script>')
    return
  }
  response.writeHead(303, { location: '/', 'set-cookie': 'dsh_launch=test-token; Path=/' })
  response.end()
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const query = mode === 'token' ? '?token=abc' : ''
  console.log('dsh web: http://127.0.0.1:' + address.port + '/' + query)
})
`, 'utf8')
  return root
}

describe('desktop runtime process', () => {
  it('waits for the real loopback Web shell and reaches quiescence on stop', async () => {
    const root = await fakeRuntime('current')
    const runtime = await launchRuntime({
      runtimeDirectory: root,
      harnessHome: join(root, 'home'),
      agentsHome: join(root, 'agents'),
      timeoutMs: 10_000,
    })
    expect(new URL(runtime.url).hostname).toBe('127.0.0.1')
    await runtime.stop()
    await expect(runtime.done).resolves.toMatchObject({ error: null })
    await expect(readFile(join(root, 'app', 'lib', 'launches.jsonl'), 'utf8')).resolves.toBe(
      '["web","--host","127.0.0.1","--port","0","--no-open"]\n',
    )
  })

  it('retries a pre-browser-launch runtime only when it rejects --no-open', async () => {
    const root = await fakeRuntime('legacy')
    const runtime = await launchRuntime({
      runtimeDirectory: root,
      harnessHome: join(root, 'home'),
      agentsHome: join(root, 'agents'),
      timeoutMs: 10_000,
    })
    await runtime.stop()
    await expect(readFile(join(root, 'app', 'lib', 'launches.jsonl'), 'utf8')).resolves.toBe(
      '["web","--host","127.0.0.1","--port","0","--no-open"]\n'
      + '["web","--host","127.0.0.1","--port","0"]\n',
    )
  })

  it('completes the launch-token handshake before accepting the Web shell', async () => {
    const root = await fakeRuntime('token')
    const runtime = await launchRuntime({
      runtimeDirectory: root,
      harnessHome: join(root, 'home'),
      agentsHome: join(root, 'agents'),
      timeoutMs: 10_000,
    })
    expect(new URL(runtime.url).search).toBe('?token=abc')
    await runtime.stop()
    await expect(readFile(join(root, 'app', 'lib', 'launches.jsonl'), 'utf8')).resolves.toBe(
      '["web","--host","127.0.0.1","--port","0","--no-open"]\n',
    )
  })
})
