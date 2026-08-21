import { describe, expect, it } from 'vitest'
import type { RuntimeManifest } from '../src/runtime-model.ts'
import {
  createDesktopVersionInfo,
  formatVersionClipboardText,
  formatVersionDialogDetail,
} from '../src/version-info.ts'

const manifest: RuntimeManifest = {
  schemaVersion: 1,
  harnessVersion: '0.1.0-rc.5',
  runtimeRevision: 2,
  platform: 'win32',
  arch: 'x64',
  asset: 'deepseek-harness-runtime.zip',
  size: 1,
  sha256: 'a'.repeat(64),
  commitSha: '0123456789abcdef0123456789abcdef01234567',
  nodeVersion: 'v24.19.0',
  minDesktopVersion: '1.0.0',
  desktopProtocolVersion: 1,
  publishedAt: '2026-08-21T00:00:00.000Z',
}

describe('desktop version information', () => {
  it('uses the selected runtime manifest independently of the desktop version', () => {
    expect(createDesktopVersionInfo(manifest, '1.0.3')).toEqual({
      harnessVersion: '0.1.0-rc.5',
      runtimeRevision: 2,
      desktopVersion: '1.0.3',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      nodeVersion: 'v24.19.0',
    })
  })

  it('formats concise dialog text and complete copied diagnostics', () => {
    const info = createDesktopVersionInfo(manifest, '1.0.3')

    expect(formatVersionDialogDetail(info)).toBe([
      'Harness 版本：0.1.0-rc.5',
      '运行时修订：r2',
      '桌面端版本：1.0.3',
    ].join('\n'))
    expect(formatVersionClipboardText(info)).toBe([
      'DeepSeek Harness',
      'Harness 版本：0.1.0-rc.5',
      '运行时修订：r2',
      '桌面端版本：1.0.3',
      '运行时提交：0123456789abcdef0123456789abcdef01234567',
      'Node 版本：v24.19.0',
    ].join('\n'))
  })
})
