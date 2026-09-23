import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'merge-upstream-runtime.sh')
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function fixture(conflictRuntime: boolean): { root: string; repo: string; forkSha: string; upstreamSha: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upstream-runtime-'))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(repo, 'scripts'))
  git(repo, 'init', '-b', 'master')
  git(repo, 'config', 'user.name', 'Runtime sync test')
  git(repo, 'config', 'user.email', 'runtime-sync@example.invalid')
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'base\n')
  writeFileSync(join(repo, '.github', 'workflows', 'obsolete.yml'), 'base\n')
  writeFileSync(join(repo, 'scripts', 'ci-workflow.spec.ts'), 'base\n')
  writeFileSync(join(repo, 'runtime.txt'), 'base\n')
  copyFileSync(script, join(repo, 'scripts', 'merge-upstream-runtime.sh'))
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'base')

  git(repo, 'switch', '-c', 'fork')
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'fork\n')
  writeFileSync(join(repo, 'scripts', 'ci-workflow.spec.ts'), 'fork\n')
  git(repo, 'rm', '.github/workflows/obsolete.yml')
  if (conflictRuntime) writeFileSync(join(repo, 'runtime.txt'), 'fork\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fork changes')
  const forkSha = git(repo, 'rev-parse', 'HEAD')

  git(repo, 'switch', '-c', 'upstream', 'master')
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'upstream\n')
  writeFileSync(join(repo, '.github', 'workflows', 'obsolete.yml'), 'upstream\n')
  writeFileSync(join(repo, '.github', 'workflows', 'new.yml'), 'upstream\n')
  writeFileSync(join(repo, 'scripts', 'ci-workflow.spec.ts'), 'upstream\n')
  writeFileSync(join(repo, 'runtime.txt'), 'upstream\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'upstream changes')
  const upstreamSha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'switch', 'fork')
  return { root, repo, forkSha, upstreamSha }
}

describe.skipIf(process.platform === 'win32' && !existsSync(bash))('upstream runtime merge', () => {
  it('preserves fork CI files while merging upstream runtime source', () => {
    const { root, repo, forkSha, upstreamSha } = fixture(false)
    try {
      const merged = spawnSync(bash, ['scripts/merge-upstream-runtime.sh', upstreamSha], {
        cwd: repo, encoding: 'utf8',
      })
      expect(merged.status, merged.stderr).toBe(0)
      expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toEqual([
        git(repo, 'rev-parse', 'HEAD'), forkSha, upstreamSha,
      ])
      expect(git(repo, 'show', 'HEAD:.github/workflows/ci.yml')).toBe('fork')
      expect(git(repo, 'show', 'HEAD:scripts/ci-workflow.spec.ts')).toBe('fork')
      expect(git(repo, 'show', 'HEAD:runtime.txt')).toBe('upstream')
      expect(existsSync(join(repo, '.github', 'workflows', 'obsolete.yml'))).toBe(false)
      expect(existsSync(join(repo, '.github', 'workflows', 'new.yml'))).toBe(false)
      expect(git(repo, 'status', '--porcelain')).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a runtime source conflict without committing it', () => {
    const { root, repo, forkSha, upstreamSha } = fixture(true)
    try {
      const merged = spawnSync(bash, ['scripts/merge-upstream-runtime.sh', upstreamSha], {
        cwd: repo, encoding: 'utf8',
      })
      expect(merged.status).not.toBe(0)
      expect(merged.stdout).toContain('Upstream runtime merge requires manual resolution')
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(forkSha)
      expect(git(repo, 'ls-files', '-u')).toContain('runtime.txt')
      expect(readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain('<<<<<<<')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
