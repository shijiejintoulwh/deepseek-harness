import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubRuntimeProvider } from '../src/github-provider.ts'

const NOW = Date.parse('2026-08-15T12:00:00Z')
const RETRY_AT = NOW + 60 * 60 * 1_000
const REPOSITORY = 'owner/repository'
const TAG = 'runtime-v0.2.0-r1'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function rateLimitedResponse(): Response {
  return new Response('{"message":"rate limit exceeded"}', {
    status: 403,
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(RETRY_AT / 1_000),
    },
  })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('GitHubRuntimeProvider discovery', () => {
  it('falls back to the public Atom feed and keeps REST blocked until reset', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.github.com/')) return rateLimitedResponse()
      if (url.endsWith('/releases.atom')) return new Response('<feed></feed>')
      throw new Error(`unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = new GitHubRuntimeProvider(REPOSITORY, 'runtime-v', 'unused')

    await expect(provider.latest()).resolves.toBeNull()
    await expect(provider.latest()).resolves.toBeNull()
    const urls = fetchMock.mock.calls.map(([input]) => requestUrl(input))
    expect(urls.filter(url => url.startsWith('https://api.github.com/'))).toHaveLength(1)
    expect(urls.filter(url => url.endsWith('/releases.atom'))).toHaveLength(2)
  })

  it('resolves and verifies direct release assets discovered through Atom', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const manifest = {
      schemaVersion: 1,
      harnessVersion: '0.2.0',
      runtimeRevision: 1,
      platform: 'win32',
      arch: 'x64',
      asset: 'runtime.zip',
      size: 123,
      sha256: '0'.repeat(64),
      commitSha: 'a'.repeat(40),
      nodeVersion: 'v24.19.0',
      minDesktopVersion: '1.0.0',
      desktopProtocolVersion: 1,
      publishedAt: '2026-08-15T11:00:00Z',
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    const signature = sign(null, manifestBytes, privateKey).toString('base64')
    const feed = `<feed><entry><id>tag:github.com,2008:Repository/123/${TAG}</id></entry></feed>`
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.github.com/')) return rateLimitedResponse()
      if (url.endsWith('/releases.atom')) return new Response(feed)
      if (url.endsWith('/runtime-manifest.json')) return new Response(new Uint8Array(manifestBytes))
      if (url.endsWith('/runtime-manifest.sig')) return new Response(signature)
      throw new Error(`unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const release = await new GitHubRuntimeProvider(REPOSITORY, 'runtime-v', publicKeyPem).latest()

    expect(release).toMatchObject({ tag: TAG, manifest, archive: { name: 'runtime.zip', size: 123 } })
    expect(release?.archive.browser_download_url)
      .toBe(`https://github.com/${REPOSITORY}/releases/download/${TAG}/runtime.zip`)
  })

  it('reports the REST retry time when the Atom fallback is also unavailable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      requestUrl(input).startsWith('https://api.github.com/')
        ? rateLimitedResponse()
        : new Response('unavailable', { status: 503 })))

    const result = new GitHubRuntimeProvider(REPOSITORY, 'runtime-v', 'unused').latest()
    await expect(result).rejects.toMatchObject({ retryAt: RETRY_AT })
  })
})
