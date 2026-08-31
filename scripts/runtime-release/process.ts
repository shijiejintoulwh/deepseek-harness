/**
 * Process helpers owned by the Windows runtime packaging tools.
 *
 * The source checkout can be an older Harness release whose general release
 * helper exposes a different API, so runtime packaging keeps this small set
 * of commands beside the tool that consumes it.
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface RunOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Run a command and capture its trimmed standard output.
 * @param command - executable name.
 * @param args - command arguments.
 * @param options - optional working directory and environment.
 * @returns The trimmed standard output.
 */
export function capture(command: string, args: readonly string[], options: RunOptions = {}): string {
  const result = spawnSync(command, [...args], { cwd: options.cwd, env: options.env, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

/**
 * Run a command with inherited streams and fail on a non-zero exit.
 * @param command - executable name.
 * @param args - command arguments.
 * @param options - optional working directory and environment.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): void {
  const result = spawnSync(command, [...args], { cwd: options.cwd, env: options.env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

/**
 * Return whether Node started this module's caller.
 * @param moduleUrl - the caller's import.meta.url.
 * @returns True when Node started this module.
 */
export function isEntry(moduleUrl: string): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  return realpathSync(invoked) === realpathSync(fileURLToPath(moduleUrl))
}
