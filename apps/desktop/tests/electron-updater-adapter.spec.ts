import { describe, expect, it, vi } from 'vitest'
import { metadataContainsInstaller } from '../src/electron-updater-adapter.ts'

vi.mock('electron-updater', () => ({
  autoUpdater: {},
  CancellationToken: vi.fn(),
}))

describe('electron updater metadata validation', () => {
  it('accepts the relative file URL emitted by electron-builder exactly once', () => {
    expect(metadataContainsInstaller(
      [{ url: 'DeepSeek-Harness-Desktop-1.0.5-preview.1-win-x64.exe' }],
      'DeepSeek-Harness-Desktop-1.0.5-preview.1-win-x64.exe',
    )).toBe(true)
  })

  it('rejects missing, duplicate, and differently named installers', () => {
    const asset = 'DeepSeek-Harness-Desktop-1.0.5-preview.1-win-x64.exe'
    expect(metadataContainsInstaller([], asset)).toBe(false)
    expect(metadataContainsInstaller([{ url: 'other.exe' }], asset)).toBe(false)
    expect(metadataContainsInstaller([{ url: asset }, { url: `https://example.invalid/${asset}` }], asset)).toBe(false)
  })
})
