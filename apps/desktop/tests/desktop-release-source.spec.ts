import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubDesktopReleaseSource } from '../src/desktop-release-source.ts'

const REPOSITORY = 'owner/repository'

afterEach(() => {
  vi.unstubAllGlobals()
})

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('GitHubDesktopReleaseSource', () => {
  it('keeps stable discovery isolated from newer preview releases', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify([
          { tag_name: 'desktop-v1.2.0-preview.2', draft: false, prerelease: true },
          { tag_name: 'desktop-v1.1.0', draft: false, prerelease: false },
          { tag_name: 'runtime-v9.0.0', draft: false, prerelease: false },
        ]))
      }
      if (url.endsWith('/desktop-update-manifest.json')) return new Response('{"stable":true}')
      if (url.endsWith('/desktop-update-manifest.sig')) return new Response('signature')
      throw new Error(`unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const release = await new GitHubDesktopReleaseSource(REPOSITORY, 'desktop-v')
      .latest('stable', new AbortController().signal)

    expect(release?.tag).toBe('desktop-v1.1.0')
    expect(release?.assetBaseUrl).toContain('/desktop-v1.1.0/')
  })

  it('selects the greatest stable or preview version for a preview install', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify([
          { tag_name: 'desktop-v1.3.0-preview.1', draft: false, prerelease: true },
          { tag_name: 'desktop-v1.2.0', draft: false, prerelease: false },
        ]))
      }
      if (url.endsWith('/desktop-update-manifest.json')) return new Response('{}')
      if (url.endsWith('/desktop-update-manifest.sig')) return new Response('signature')
      throw new Error(`unexpected URL: ${url}`)
    }))

    const release = await new GitHubDesktopReleaseSource(REPOSITORY, 'desktop-v')
      .latest('preview', new AbortController().signal)

    expect(release?.tag).toBe('desktop-v1.3.0-preview.1')
  })

  it('falls back to Atom discovery when the anonymous REST API is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.github.com/')) return new Response('limited', { status: 403 })
      if (url.endsWith('/releases.atom')) {
        return new Response('<feed><entry><id>tag:github.com,2008:Repository/1/desktop-v2.0.0</id></entry></feed>')
      }
      if (url.endsWith('/desktop-update-manifest.json')) return new Response('{}')
      if (url.endsWith('/desktop-update-manifest.sig')) return new Response('signature')
      throw new Error(`unexpected URL: ${url}`)
    }))

    const release = await new GitHubDesktopReleaseSource(REPOSITORY, 'desktop-v')
      .latest('stable', new AbortController().signal)

    expect(release?.tag).toBe('desktop-v2.0.0')
  })

  it('continues past runtime-only pages before selecting a desktop release', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes('page=1')) {
        return new Response(JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
          tag_name: `runtime-v1.0.${index}`,
          draft: false,
          prerelease: false,
        }))))
      }
      if (url.includes('page=2')) {
        return new Response(JSON.stringify([
          { tag_name: 'desktop-v1.4.0', draft: false, prerelease: false },
        ]))
      }
      if (url.endsWith('/desktop-update-manifest.json')) return new Response('{}')
      if (url.endsWith('/desktop-update-manifest.sig')) return new Response('signature')
      throw new Error(`unexpected URL: ${url}`)
    }))

    const release = await new GitHubDesktopReleaseSource(REPOSITORY, 'desktop-v')
      .latest('stable', new AbortController().signal)

    expect(release?.tag).toBe('desktop-v1.4.0')
  })
})
