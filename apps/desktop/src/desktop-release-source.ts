/** Public GitHub discovery for independently signed desktop-shell releases. */

import { compare, prerelease, valid } from 'semver'
import { z } from 'zod'
import type { ShellUpdateChannel, ShellUpdateEnvelope } from './shell-updater.ts'

const releaseSchema = z.looseObject({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
})
const releasesSchema = z.array(releaseSchema)
const API_RESPONSE_LIMIT = 2 * 1024 * 1024
const ATOM_RESPONSE_LIMIT = 512 * 1024
const MANIFEST_RESPONSE_LIMIT = 64 * 1024
const SIGNATURE_RESPONSE_LIMIT = 4 * 1024
const RELEASES_PER_PAGE = 30
const MAX_RELEASE_PAGES = 20
const safeReleaseTag = /^[0-9A-Za-z][0-9A-Za-z._-]*$/

/** Exact release location retained for the later consented download. */
export interface DesktopReleaseLocation extends ShellUpdateEnvelope {
  /** Immutable GitHub release tag. */
  readonly tag: string
  /** Semantic version encoded by the desktop tag. */
  readonly version: string
  /** Public directory containing the release assets. */
  readonly assetBaseUrl: string
}

/** Headers for unauthenticated public GitHub requests. */
function githubHeaders(accept = 'application/vnd.github+json'): HeadersInit {
  return {
    Accept: accept,
    'User-Agent': 'DeepSeek-Harness-Desktop',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/** Read one successful response without allowing unbounded remote bytes. */
async function readBounded(response: Response, url: string, limit: number): Promise<Buffer> {
  if (!response.ok) throw new Error(`GitHub request ${url} failed with ${response.status}`)
  if (response.body === null) throw new Error(`GitHub request ${url} returned no body`)
  const declaredSize = response.headers.get('content-length')
  if (declaredSize !== null && Number(declaredSize) > limit) {
    await response.body.cancel()
    throw new Error(`GitHub response ${url} exceeds ${limit} bytes`)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    size += result.value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error(`GitHub response ${url} exceeds ${limit} bytes`)
    }
    chunks.push(result.value)
  }
  return Buffer.concat(chunks, size)
}

/** Fetch one bounded public asset. */
async function fetchBounded(url: string, limit: number, signal: AbortSignal, accept?: string): Promise<Buffer> {
  const response = await fetch(url, { headers: githubHeaders(accept), signal })
  return readBounded(response, url, limit)
}

/** Extract the semantic version represented by one desktop-only tag. */
function taggedVersion(tag: string, prefix: string): string | null {
  if (!tag.startsWith(prefix) || !safeReleaseTag.test(tag)) return null
  const version = tag.slice(prefix.length)
  return valid(version)
}

/** Apply the installed channel to one release tag. */
function channelAccepts(version: string, channel: ShellUpdateChannel): boolean {
  return channel === 'preview' || prerelease(version) === null
}

/** Select the greatest valid version without trusting feed ordering. */
function latestTag(tags: readonly string[], prefix: string, channel: ShellUpdateChannel): string | null {
  let latest: { tag: string; version: string } | null = null
  for (const tag of tags) {
    const version = taggedVersion(tag, prefix)
    if (version === null || !channelAccepts(version, channel)) continue
    if (latest === null || compare(version, latest.version) > 0) latest = { tag, version }
  }
  return latest?.tag ?? null
}

/** Extract release tags from GitHub's public Atom feed. */
function atomTags(xml: string): string[] {
  const tags = new Set<string>()
  for (const match of xml.matchAll(/<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g)) {
    if (match[1] !== undefined) tags.add(match[1])
  }
  return [...tags]
}

/** Build one release download URL from validated path segments. */
function releaseAssetUrl(repository: string, tag: string, asset: string): string {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`
}

/** GitHub source that discovers signed desktop manifest envelopes. */
export class GitHubDesktopReleaseSource {
  /**
   * @param repository - public `owner/name` repository.
   * @param tagPrefix - desktop-only release prefix.
   */
  constructor(
    private readonly repository: string,
    private readonly tagPrefix: string,
  ) {
    if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(repository)) {
      throw new Error(`invalid GitHub repository: ${repository}`)
    }
    if (!safeReleaseTag.test(tagPrefix)) throw new Error(`invalid GitHub release tag prefix: ${tagPrefix}`)
  }

  /** Discover the greatest release tag accepted by the installed channel. */
  private async discoverTag(channel: ShellUpdateChannel, signal: AbortSignal): Promise<string | null> {
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      const apiUrl = `https://api.github.com/repos/${this.repository}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`
      const response = await fetch(apiUrl, { headers: githubHeaders(), signal })
      if (!response.ok) {
        await response.body?.cancel()
        if (page !== 1) throw new Error(`GitHub release discovery failed on page ${page} with ${response.status}`)
        const atomUrl = `https://github.com/${this.repository}/releases.atom`
        const atom = await fetchBounded(atomUrl, ATOM_RESPONSE_LIMIT, signal, 'application/atom+xml')
        return latestTag(atomTags(atom.toString('utf8')), this.tagPrefix, channel)
      }
      const releases = releasesSchema.parse(
        JSON.parse((await readBounded(response, apiUrl, API_RESPONSE_LIMIT)).toString('utf8')) as unknown,
      )
      const tags = releases
        .filter(release => !release.draft)
        .filter((release) => {
          const version = taggedVersion(release.tag_name, this.tagPrefix)
          return version !== null && release.prerelease === (prerelease(version) !== null)
        })
        .map(release => release.tag_name)
      const candidate = latestTag(tags, this.tagPrefix, channel)
      if (candidate !== null) return candidate
      if (releases.length < RELEASES_PER_PAGE) return null
    }
    throw new Error(`desktop release discovery exceeded ${MAX_RELEASE_PAGES} GitHub pages`)
  }

  /**
   * Fetch the exact signed manifest envelope for the installed channel.
   * @param channel - release channel selected by the installed desktop version.
   * @param signal - caller cancellation signal.
   * @returns Release location and signed bytes, or null when no desktop release exists.
   */
  async latest(channel: ShellUpdateChannel, signal: AbortSignal): Promise<DesktopReleaseLocation | null> {
    const tag = await this.discoverTag(channel, signal)
    if (tag === null) return null
    const version = taggedVersion(tag, this.tagPrefix)
    if (version === null) throw new Error(`invalid discovered desktop release tag: ${tag}`)
    const manifestUrl = releaseAssetUrl(this.repository, tag, 'desktop-update-manifest.json')
    const signatureUrl = releaseAssetUrl(this.repository, tag, 'desktop-update-manifest.sig')
    const [manifestBytes, signatureBytes] = await Promise.all([
      fetchBounded(manifestUrl, MANIFEST_RESPONSE_LIMIT, signal),
      fetchBounded(signatureUrl, SIGNATURE_RESPONSE_LIMIT, signal),
    ])
    return {
      tag,
      version,
      assetBaseUrl: `https://github.com/${this.repository}/releases/download/${encodeURIComponent(tag)}/`,
      manifestBytes,
      signatureText: signatureBytes.toString('utf8'),
    }
  }
}
