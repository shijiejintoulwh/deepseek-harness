/**
 * Harness child-process supervision. The desktop host launches the bundled
 * Node executable, waits for the loopback URL and real Web shell, and does not
 * report shutdown complete until the process tree has exited.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

type RuntimeChild = ChildProcessByStdio<null, Readable, Readable>

const unsupportedNoOpenOption = /error: unknown option ['"]--no-open['"]/

/** Internal signal that the installed runtime predates browser suppression. */
class UnsupportedNoOpenOptionError extends Error {}

/** Independent process-exit facts. */
export interface RuntimeExit {
  /** Exit status, or null when a signal ended the process. */
  readonly exitCode: number | null
  /** Exit signal when available. */
  readonly signal: NodeJS.Signals | null
  /** Spawn or process error emitted before exit. */
  readonly error: Error | null
}

/** Inputs required to launch one installed runtime. */
export interface RuntimeLaunchOptions {
  /** Installed runtime directory containing `node/` and `app/`. */
  readonly runtimeDirectory: string
  /** Desktop-specific Harness home. */
  readonly harnessHome: string
  /** Desktop-specific agent instruction home. */
  readonly agentsHome: string
  /** Maximum startup time. */
  readonly timeoutMs: number
  /** Runtime output sink. */
  readonly onOutput?: (stream: 'stdout' | 'stderr', text: string) => void
}

/** Parse and validate the one URL line owned by the Web bundle. */
function parseRuntimeUrl(line: string): string | null {
  const match = /^dsh web:\s+(http:\/\/[^\s]+)\s*$/.exec(line)
  if (match === null) return null
  const rawUrl = match[1]
  if (rawUrl === undefined) throw new Error('Harness URL output did not contain a URL')
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error(`Harness announced a non-loopback URL: ${url.href}`)
  }
  return url.href
}

/** Collect complete lines from chunked process output with a bounded tail. */
function observeLines(
  child: RuntimeChild,
  onOutput: RuntimeLaunchOptions['onOutput'],
  onLine: (line: string) => void,
  onError: (error: Error) => void,
): void {
  let stdoutTail = ''
  let stderrTail = ''
  const observe = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    onOutput?.(stream, text)
    const combined = (stream === 'stdout' ? stdoutTail : stderrTail) + text
    const lines = combined.split(/\r?\n/)
    const tail = lines.pop() ?? ''
    if (tail.length > 64 * 1024) {
      onError(new Error(`Harness ${stream} line exceeds 64 KiB`))
      return
    }
    if (stream === 'stdout') stdoutTail = tail
    else stderrTail = tail
    for (const line of lines) onLine(line)
  }
  child.stdout.on('data', (chunk: Buffer) => {
    observe('stdout', chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    observe('stderr', chunk)
  })
}

/** First session cookie pair from a response's Set-Cookie headers, if any. */
function responseCookie(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const values = headers.getSetCookie?.() ?? []
  const fallback = response.headers.get('set-cookie')
  const candidates = values.length === 0 && fallback !== null ? [fallback] : values
  for (const value of candidates) {
    const separator = value.indexOf(';')
    const cookie = value.slice(0, separator === -1 ? undefined : separator).trim()
    if (cookie.includes('=')) return cookie
  }
  return null
}

/**
 * Prove the Web shell is ready through the runtime's launch-token handshake.
 * Runtimes since 0.1.2-alpha.3 answer the announced token URL with 303 to `/`
 * plus a session cookie; older runtimes serve the boot marker directly.
 * @param url - exact loopback URL announced by the runtime.
 * @returns True when the reachable page carries the boot marker.
 */
async function probeWebShell(url: string): Promise<boolean> {
  const launch = await fetch(url, { redirect: 'manual' })
  if (launch.status === 303 && launch.headers.get('location') === '/') {
    const cookie = responseCookie(launch)
    await launch.arrayBuffer()
    if (cookie === null) return false
    const authenticated = new URL(url)
    authenticated.search = ''
    const response = await fetch(authenticated, { headers: { cookie }, redirect: 'error' })
    if (response.status !== 200) {
      await response.arrayBuffer()
      return false
    }
    return (await response.text()).includes('__DSH_BOOT__')
  }
  if (launch.status !== 200) {
    await launch.arrayBuffer()
    return false
  }
  return (await launch.text()).includes('__DSH_BOOT__')
}

/** Wait until the served page proves the Harness Web shell is ready. */
async function waitForHealth(url: string, deadline: number): Promise<void> {
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await probeWebShell(url)) return
      lastError = new Error('Harness health response did not prove the Web shell')
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error('Harness did not serve a healthy Web shell before the startup deadline', { cause: lastError })
}

/** Wait for a child command used only during exact-PID cleanup. */
async function waitForCommand(child: ReturnType<typeof spawn>): Promise<void> {
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (status !== 0) throw new Error(`process-tree cleanup exited with ${String(status)}`)
}

/** Live Harness process and its quiescent shutdown operation. */
export class RunningRuntime {
  /** Healthy loopback application URL. */
  readonly url: string
  /** Process completion with independent exit facts. */
  readonly done: Promise<RuntimeExit>

  private stopped = false

  /** @internal Constructed only by {@link launchRuntime}. */
  constructor(
    private readonly child: RuntimeChild,
    url: string,
    done: Promise<RuntimeExit>,
  ) {
    this.url = url
    this.done = done
  }

  /**
   * Request graceful exit, then terminate the exact Windows process tree if it
   * remains alive. The promise resolves only after process exit.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      await this.done
      return
    }
    this.stopped = true
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      await this.done
      return
    }
    this.child.kill()
    const graceful = await Promise.race([
      this.done.then(() => true),
      delay(5_000).then(() => false),
    ])
    if (graceful) return

    const pid = this.child.pid
    if (pid === undefined) throw new Error('Harness process has no PID for cleanup')
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const taskkill = join(systemRoot, 'System32', 'taskkill.exe')
      await waitForCommand(spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }))
    } else {
      this.child.kill('SIGKILL')
    }
    const forced = await Promise.race([
      this.done.then(() => true),
      delay(5_000).then(() => false),
    ])
    if (!forced) throw new Error(`Harness process ${pid} did not exit after forced cleanup`)
  }
}

/**
 * Start an installed Harness runtime and wait for its real Web shell.
 * @param options - runtime paths, homes, timeout, and log sink.
 * @returns Healthy live runtime.
 */
async function launchRuntimeAttempt(
  options: RuntimeLaunchOptions,
  suppressBrowser: boolean,
): Promise<RunningRuntime> {
  const node = join(options.runtimeDirectory, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const entry = join(options.runtimeDirectory, 'app', 'lib', 'bin.js')
  const environment = { ...process.env }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  environment.DSH_HOME = options.harnessHome
  environment.DSH_AGENTS_HOME = options.agentsHome

  const runtimeArguments = [entry, 'web', '--host', '127.0.0.1', '--port', '0']
  if (suppressBrowser) runtimeArguments.push('--no-open')
  const child = spawn(node, runtimeArguments, {
    cwd: join(options.runtimeDirectory, 'app'),
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let resolveExit: (exit: RuntimeExit) => void = () => undefined
  const done = new Promise<RuntimeExit>((resolve) => {
    resolveExit = resolve
  })
  let processError: Error | null = null
  child.once('error', (error) => {
    processError = error
  })
  child.once('close', (exitCode, signal) => {
    resolveExit({ exitCode, signal, error: processError })
  })

  let resolveUrl: (url: string) => void = () => undefined
  let rejectUrl: (error: Error) => void = () => undefined
  const announcedUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve
    rejectUrl = reject
  })
  let stderrTail = ''
  try {
    observeLines(
      child,
      (stream, text) => {
        if (stream === 'stderr') stderrTail = (stderrTail + text).slice(-4_096)
        options.onOutput?.(stream, text)
      },
      (line) => {
        try {
          const url = parseRuntimeUrl(line)
          if (url !== null) resolveUrl(url)
        } catch (error) {
          rejectUrl(error instanceof Error ? error : new Error(String(error)))
        }
      },
      rejectUrl,
    )
    const deadline = Date.now() + options.timeoutMs
    const url = await Promise.race([
      announcedUrl,
      done.then((exit) => {
        throw new Error(`Harness exited before announcing its URL: ${JSON.stringify(exit)}`)
      }),
      delay(options.timeoutMs).then(() => {
        throw new Error('Harness did not announce its URL before the startup deadline')
      }),
    ])
    await waitForHealth(url, deadline)
    return new RunningRuntime(child, url, done)
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await Promise.race([done, delay(5_000)])
    }
    if (suppressBrowser && unsupportedNoOpenOption.test(stderrTail)) {
      throw new UnsupportedNoOpenOptionError('Harness runtime does not support --no-open', { cause: error })
    }
    throw error
  }
}

/**
 * Start an installed Harness runtime without opening a separate browser.
 * Runtimes that predate browser launching also predate `--no-open`; retry only
 * when that exact option is rejected.
 * @param options - runtime paths, homes, timeout, and log sink.
 * @returns Healthy live runtime.
 */
export async function launchRuntime(options: RuntimeLaunchOptions): Promise<RunningRuntime> {
  try {
    return await launchRuntimeAttempt(options, true)
  } catch (error) {
    if (!(error instanceof UnsupportedNoOpenOptionError)) throw error
    return launchRuntimeAttempt(options, false)
  }
}
