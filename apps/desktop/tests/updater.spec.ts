import { describe, expect, it } from 'vitest'
import type { AvailableRuntimeRelease, GitHubRuntimeProvider } from '../src/github-provider.ts'
import type { RuntimeManifest, RuntimeState } from '../src/runtime-model.ts'
import type { RuntimeStore } from '../src/runtime-store.ts'
import { RuntimeUpdater } from '../src/updater.ts'

function manifest(harnessVersion: string, runtimeRevision: number): RuntimeManifest {
  return {
    schemaVersion: 1,
    harnessVersion,
    runtimeRevision,
    platform: 'win32',
    arch: 'x64',
    asset: 'runtime.zip',
    size: 1,
    sha256: 'a'.repeat(64),
    commitSha: 'b'.repeat(40),
    nodeVersion: 'v24.9.0',
    minDesktopVersion: '1.0.0',
    desktopProtocolVersion: 1,
    publishedAt: '2026-08-22T00:00:00.000Z',
  }
}

function release(value: RuntimeManifest): AvailableRuntimeRelease {
  return {
    manifest: value,
    manifestBytes: Buffer.from('{}'),
    signatureText: '',
    archive: { name: 'runtime.zip', size: 1, browser_download_url: 'https://example.invalid/runtime.zip' },
    tag: `runtime-v${value.harnessVersion}-r${value.runtimeRevision}`,
  }
}

function state(overrides: Partial<RuntimeState>): RuntimeState {
  return {
    schemaVersion: 1,
    active: null,
    previous: null,
    pending: null,
    pendingFailures: 0,
    skipped: null,
    ...overrides,
  }
}

function providerWith(latest: AvailableRuntimeRelease | null): GitHubRuntimeProvider {
  return {
    async latest(): Promise<AvailableRuntimeRelease | null> {
      return latest
    },
  } as unknown as GitHubRuntimeProvider
}

function storeWith(installed: Record<string, RuntimeManifest>): RuntimeStore {
  return {
    async readInstalledManifest(id: string): Promise<RuntimeManifest> {
      const found = installed[id]
      if (found === undefined) throw new Error(`no installed runtime: ${id}`)
      return found
    },
  } as unknown as RuntimeStore
}

describe('RuntimeUpdater.check', () => {
  it('reports none while the staged pending runtime already matches the latest release', async () => {
    const latest = release(manifest('0.1.1-rc.2', 1))
    const updater = new RuntimeUpdater(
      providerWith(latest),
      storeWith({ '0.1.0-rc.8-r2': manifest('0.1.0-rc.8', 2), '0.1.1-rc.2-r1': manifest('0.1.1-rc.2', 1) }),
      '1.5.0',
      1,
    )
    await expect(updater.check(state({ active: '0.1.0-rc.8-r2', pending: '0.1.1-rc.2-r1' })))
      .resolves.toEqual({ kind: 'none' })
  })

  it('reports none when the active runtime already matches the latest release', async () => {
    const latest = release(manifest('0.1.1-rc.2', 1))
    const updater = new RuntimeUpdater(
      providerWith(latest),
      storeWith({ '0.1.1-rc.2-r1': manifest('0.1.1-rc.2', 1) }),
      '1.5.0',
      1,
    )
    await expect(updater.check(state({ active: '0.1.1-rc.2-r1' }))).resolves.toEqual({ kind: 'none' })
  })

  it('offers an update when the selected runtime is older than the latest release', async () => {
    const latest = release(manifest('0.1.1-rc.2', 1))
    const updater = new RuntimeUpdater(
      providerWith(latest),
      storeWith({ '0.1.0-rc.8-r2': manifest('0.1.0-rc.8', 2) }),
      '1.5.0',
      1,
    )
    await expect(updater.check(state({ active: '0.1.0-rc.8-r2' }))).resolves.toEqual({
      kind: 'available',
      release: latest,
    })
  })

  it('offers a newer release that supersedes the staged pending runtime', async () => {
    const latest = release(manifest('0.1.1-rc.2', 2))
    const updater = new RuntimeUpdater(
      providerWith(latest),
      storeWith({ '0.1.0-rc.8-r2': manifest('0.1.0-rc.8', 2), '0.1.1-rc.2-r1': manifest('0.1.1-rc.2', 1) }),
      '1.5.0',
      1,
    )
    await expect(updater.check(state({ active: '0.1.0-rc.8-r2', pending: '0.1.1-rc.2-r1' })))
      .resolves.toEqual({ kind: 'available', release: latest })
  })
})
