/**
 * Build a portable Windows x64 Harness runtime from the reviewed checkout.
 * pnpm deploy materializes the CLI production closure, the selected Node 24
 * executable is copied beside it, and the complete directory is ZIP-compressed
 * before its digest enters a signed manifest.
 */

import { createHash } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync as readTextFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { isEntry, run, capture } from '../release/process.ts'
import { renderRuntimeManifest, runtimeManifest, signRuntimeManifest } from './manifest.ts'

type SmokeChild = ChildProcessByStdio<null, Readable, Readable>

/** Parsed build inputs. */
interface BuildOptions {
  readonly out: string
  readonly nodeExe: string
  readonly privateKey: string
  readonly runtimeRevision: number
  readonly minDesktopVersion: string
  readonly desktopProtocolVersion: number
  readonly skipBuild: boolean
}

/** Resolve the pnpm JavaScript entry so Windows stays shell-free. */
function pnpmInvocation(args: string[]): { command: string; args: string[] } {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('runtime build must be invoked through a pnpm package script')
  }
  return { command: process.execPath, args: [entrypoint, ...args] }
}

/** Hash a completed archive synchronously for release-script simplicity. */
async function sha256(filename: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filename) as AsyncIterable<Buffer>) digest.update(chunk)
  return digest.digest('hex')
}

/** Ensure cleanup can target only the exact temporary directory shape we create. */
function assertRuntimeStagingDirectory(candidate: string): void {
  const absolute = resolve(candidate)
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('dsh-windows-runtime-')) {
    throw new Error(`invalid runtime staging directory: ${candidate}`)
  }
}

/** Remove generated staging content without following pnpm links or junctions. */
function removeTreeNoFollow(target: string): void {
  const info = lstatSync(target)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    unlinkSync(target)
    return
  }
  for (const name of readdirSync(target)) removeTreeNoFollow(join(target, name))
  rmdirSync(target)
}

/** Reject a deployment link that would make the archive depend on the build workspace. */
function assertLinksStayInside(root: string, current: string = root): void {
  const rootAbsolute = resolve(root)
  for (const name of readdirSync(current)) {
    const entry = join(current, name)
    const info = lstatSync(entry)
    if (info.isSymbolicLink()) {
      const target = realpathSync(entry)
      const rel = relative(rootAbsolute, target)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`runtime deployment link escapes its root: ${entry} -> ${target}`)
      }
      continue
    }
    if (info.isDirectory()) assertLinksStayInside(rootAbsolute, entry)
  }
}

/** Stop the exact smoke-test process tree and wait until output handles close. */
async function stopSmokeProcess(child: SmokeChild, closed: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed
    return
  }
  child.kill()
  const graceful = await Promise.race([closed.then(() => true), delay(5_000).then(() => false)])
  if (graceful) return
  const pid = child.pid
  if (pid === undefined) throw new Error('runtime smoke process has no PID')
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  run(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'])
  const forced = await Promise.race([closed.then(() => true), delay(5_000).then(() => false)])
  if (!forced) throw new Error(`runtime smoke process ${pid} did not exit`)
}

/** Launch the staged runtime and require its real loopback Web shell. */
async function smokeRuntime(runtimeDirectory: string): Promise<void> {
  const environment = { ...process.env }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  const smokeHome = join(runtimeDirectory, '.smoke-home')
  const smokeAgentsHome = join(runtimeDirectory, '.smoke-agents-home')
  environment.DSH_HOME = smokeHome
  environment.DSH_AGENTS_HOME = smokeAgentsHome
  const child = spawn(
    join(runtimeDirectory, 'node', 'node.exe'),
    [join(runtimeDirectory, 'app', 'lib', 'bin.js'), 'web', '--host', '127.0.0.1', '--port', '0'],
    {
      cwd: join(runtimeDirectory, 'app'),
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  let processError: Error | null = null
  let resolveUrl: (url: string) => void = () => undefined
  const announced = new Promise<string>((resolveUrlPromise) => {
    resolveUrl = resolveUrlPromise
  })
  const observe = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-256 * 1024)
    const matches = [...output.matchAll(/^dsh web:\s+(http:\/\/[^\s]+)\s*$/gm)]
    const latest = matches.at(-1)?.[1]
    if (latest !== undefined) resolveUrl(latest)
  }
  child.stdout.on('data', observe)
  child.stderr.on('data', observe)
  child.once('error', (error) => {
    processError = error
  })
  const closed = new Promise<void>((resolveClosed) => {
    child.once('close', () => {
      resolveClosed()
    })
  })
  try {
    const url = await Promise.race([
      announced,
      closed.then(() => {
        throw new Error(`runtime smoke process exited before announcing a URL: ${processError?.message ?? output}`)
      }),
      delay(30_000).then(() => {
        throw new Error(`runtime smoke process did not announce a URL: ${output}`)
      }),
    ])
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
      throw new Error(`runtime smoke process announced an unsafe URL: ${url}`)
    }
    const deadline = Date.now() + 30_000
    let healthy = false
    while (Date.now() < deadline) {
      try {
        const response = await fetch(parsed, { redirect: 'error' })
        const body = await response.text()
        if (response.status === 200 && body.includes('__DSH_BOOT__')) {
          healthy = true
          break
        }
      } catch {
        // Startup probes retry until the bounded deadline.
      }
      await delay(100)
    }
    if (!healthy) throw new Error(`runtime smoke process did not serve a healthy Web shell: ${output}`)
  } finally {
    await stopSmokeProcess(child, closed)
    if (existsSync(smokeHome)) removeTreeNoFollow(smokeHome)
    if (existsSync(smokeAgentsHome)) removeTreeNoFollow(smokeAgentsHome)
  }
}

/** Parse command-line build inputs. */
function options(): BuildOptions {
  const { values } = parseArgs({
    args: process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2),
    options: {
      out: { type: 'string', default: 'dist-desktop/runtime' },
      'node-exe': { type: 'string', default: process.execPath },
      'private-key': { type: 'string' },
      'runtime-revision': { type: 'string', default: '1' },
      'min-desktop-version': { type: 'string', default: '1.0.0' },
      'desktop-protocol-version': { type: 'string', default: '1' },
      'skip-build': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  const privateKey = values['private-key']
  if (privateKey === undefined || privateKey === '') throw new Error('--private-key is required')
  const runtimeRevision = Number(values['runtime-revision'])
  const desktopProtocolVersion = Number(values['desktop-protocol-version'])
  if (!Number.isInteger(runtimeRevision) || runtimeRevision < 1) throw new Error('--runtime-revision must be positive')
  if (!Number.isInteger(desktopProtocolVersion) || desktopProtocolVersion < 1) {
    throw new Error('--desktop-protocol-version must be positive')
  }
  return {
    out: resolve(values.out),
    nodeExe: resolve(values['node-exe']),
    privateKey: resolve(privateKey),
    runtimeRevision,
    minDesktopVersion: values['min-desktop-version'],
    desktopProtocolVersion,
    skipBuild: values['skip-build'],
  }
}

/** Build the complete signed release asset set. */
async function main(): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Windows runtime build requires native win32 x64')
  }
  const input = options()
  if (!existsSync(input.nodeExe)) throw new Error(`Node executable does not exist: ${input.nodeExe}`)
  const root = process.cwd()
  const rootManifest = JSON.parse(readTextFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof rootManifest.version !== 'string') throw new Error('root package.json has no version')
  const nodeVersion = capture(input.nodeExe, ['--version'])
  if (!nodeVersion.startsWith('v24.')) throw new Error(`runtime Node must be v24, received ${nodeVersion}`)
  const commitSha = capture('git', ['rev-parse', 'HEAD'], { cwd: root })

  mkdirSync(input.out, { recursive: true, mode: 0o700 })
  const staging = mkdtempSync(join(tmpdir(), 'dsh-windows-runtime-'))
  assertRuntimeStagingDirectory(staging)
  try {
    if (!input.skipBuild) {
      const build = pnpmInvocation(['run', 'build'])
      run(build.command, build.args, { cwd: root })
    }
    const appDirectory = join(staging, 'app')
    const deploy = pnpmInvocation([
      '--config.inject-workspace-packages=true',
      '--config.node-linker=hoisted',
      '--filter',
      '@deepseek-ai/dsh',
      'deploy',
      '--prod',
      '--ignore-scripts',
      appDirectory,
    ])
    run(deploy.command, deploy.args, { cwd: root })
    assertLinksStayInside(appDirectory)

    const nodeDirectory = join(staging, 'node')
    mkdirSync(nodeDirectory, { mode: 0o700 })
    copyFileSync(input.nodeExe, join(nodeDirectory, 'node.exe'))
    copyFileSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))
    copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(staging, 'THIRD_PARTY_NOTICES.md'))
    await smokeRuntime(staging)

    const releaseId = `${rootManifest.version}-r${input.runtimeRevision}`
    const asset = `deepseek-harness-runtime-win32-x64-${releaseId}.zip`
    const archiveTemp = join(input.out, `.${asset}.${process.pid}.tmp.zip`)
    const archive = join(input.out, asset)
    if (existsSync(archiveTemp) || existsSync(archive)) throw new Error(`runtime archive already exists: ${archive}`)
    run('tar', [
      '-a',
      '-c',
      '-h',
      '-f',
      archiveTemp,
      '-C',
      staging,
      'app',
      'node',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ])
    renameSync(archiveTemp, archive)

    const manifest = runtimeManifest({
      harnessVersion: rootManifest.version,
      runtimeRevision: input.runtimeRevision,
      asset,
      size: statSync(archive).size,
      sha256: await sha256(archive),
      commitSha,
      nodeVersion,
      minDesktopVersion: input.minDesktopVersion,
      desktopProtocolVersion: input.desktopProtocolVersion,
      publishedAt: new Date().toISOString(),
    })
    const manifestBytes = renderRuntimeManifest(manifest)
    const privateKeyPem = readTextFileSync(input.privateKey, 'utf8')
    writeFileSync(join(input.out, 'runtime-manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 })
    writeFileSync(join(input.out, 'runtime-manifest.sig'), signRuntimeManifest(manifestBytes, privateKeyPem), {
      flag: 'wx',
      mode: 0o600,
    })
    console.log(`runtime archive: ${archive}`)
    console.log(`runtime manifest: ${join(input.out, 'runtime-manifest.json')}`)
  } finally {
    assertRuntimeStagingDirectory(staging)
    removeTreeNoFollow(staging)
  }
}

if (isEntry(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
