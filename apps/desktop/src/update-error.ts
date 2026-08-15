/** User-facing diagnostics for desktop runtime update failures. */

import { GitHubRateLimitError } from './github-provider.ts'

/**
 * Describe an update failure without exposing transport-only status codes.
 * @param error - failure raised by update discovery or installation.
 * @param now - current epoch milliseconds used for a stable retry estimate.
 * @returns concise Chinese detail for the native error dialog.
 */
export function describeUpdateFailure(error: unknown, now = Date.now()): string {
  if (error instanceof GitHubRateLimitError) {
    const minutes = Math.max(1, Math.ceil((error.retryAt - now) / 60_000))
    return `GitHub 更新服务请求受限，请在约 ${minutes} 分钟后重试。`
  }
  return error instanceof Error ? error.message : String(error)
}
