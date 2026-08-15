import { describe, expect, it } from 'vitest'
import { GitHubRateLimitError } from '../src/github-provider.ts'
import { describeUpdateFailure } from '../src/update-error.ts'

describe('desktop update failure diagnostics', () => {
  it('turns a REST reset into an actionable retry estimate', () => {
    const now = Date.parse('2026-08-15T12:00:00Z')
    const error = new GitHubRateLimitError(now + 3_599_000)

    expect(describeUpdateFailure(error, now))
      .toMatchInlineSnapshot('"GitHub 更新服务请求受限，请在约 60 分钟后重试。"')
  })

  it('preserves non-rate-limit diagnostics', () => {
    expect(describeUpdateFailure(new Error('network unavailable'), 0)).toBe('network unavailable')
    expect(describeUpdateFailure('unknown failure', 0)).toBe('unknown failure')
  })
})
