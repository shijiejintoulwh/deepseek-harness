/**
 * Public GitHub Releases provider for signed Harness runtimes. GitHub chooses
 * transport and availability; the embedded Ed25519 key and signed digest remain
 * the authority for installable bytes.
 */

import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { z } from 'zod'
import {
  type RuntimeManifest,
  compareRuntimeVersions,
  parseRuntimeManifest,
  verifyManifestSignature,
} from './runtime-model.ts'

const releaseAssetSchema = z.looseObject({
  name: z.string(),
  size: z.number().int().nonnegative(),
  browser_download_url: z.url(),
})

const releaseSchema = z.looseObject({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.iso.datetime({ offset: true }).nullable(),
  assets: z.array(releaseAssetSchema),
})

const releasesSchema = z.array(releaseSchema)
type GitHubRelease = z.infer<typeof releaseSchema>
type GitHubAsset = z.infer<typeof releaseAssetSchema>

/** Signed release selected from the repository feed. */
export interface AvailableRuntimeRelease {
  /** Validated signed manifest. */
  readonly manifest: RuntimeManifest
  /** Exact bytes covered by the signature. */
  readonly manifestBytes: Buffer
  /** Detached base64 signature. */
  readonly signatureText: string
  /** GitHub asset carrying the signed archive. */
  readonly archive: GitHubAsset
  /** Release tag used for diagnostics. */
  readonly tag: string
}

/** Progress reported while downloading a runtime archive. */
export interface DownloadProgress {
  /** Bytes durably handed to the local file stream. */
  readonly received: number
  /** Signed archive size. */
  readonly total: number
}

/** Headers used for unauthenticated public GitHub API requests. */
function githubHeaders(): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'DeepSeek-Harness-Desktop',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/** Fetch a successful bounded response into memory. */
async function fetchBounded(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { headers: githubHeaders() })
  if (!response.ok) throw new Error(`GitHub request ${url} failed with ${response.status}`)
  if (response.body === null) throw new Error(`GitHub request ${url} returned no body`)
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > limit) {
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

/** Find one exact asset or fail on a malformed release. */
function requiredAsset(release: GitHubRelease, name: string): GitHubAsset {
  const matches = release.assets.filter(asset => asset.name === name)
  if (matches.length !== 1) {
    throw new Error(`release ${release.tag_name} must contain exactly one ${name} asset`)
  }
  const asset = matches[0]
  if (asset === undefined) throw new Error(`release ${release.tag_name} is missing ${name}`)
  return asset
}

/**
 * Fetch and validate one runtime-prefixed GitHub Release.
 * @param release - release API row.
 * @param publicKeyPem - trusted signing key.
 * @returns Signed runtime candidate.
 */
async function resolveRelease(release: GitHubRelease, publicKeyPem: string): Promise<AvailableRuntimeRelease> {
  const manifestAsset = requiredAsset(release, 'runtime-manifest.json')
  const signatureAsset = requiredAsset(release, 'runtime-manifest.sig')
  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchBounded(manifestAsset.browser_download_url, 64 * 1024),
    fetchBounded(signatureAsset.browser_download_url, 4 * 1024),
  ])
  const signatureText = signatureBytes.toString('utf8')
  verifyManifestSignature(manifestBytes, signatureText, publicKeyPem)
  const manifest = parseRuntimeManifest(manifestBytes)
  const archive = requiredAsset(release, manifest.asset)
  if (archive.size !== manifest.size) {
    throw new Error(`release ${release.tag_name} archive size disagrees with its signed manifest`)
  }
  return { manifest, manifestBytes, signatureText, archive, tag: release.tag_name }
}

/** GitHub-backed runtime discovery and archive download. */
export class GitHubRuntimeProvider {
  /**
   * @param repository - public `owner/name` repository.
   * @param tagPrefix - runtime-only release prefix.
   * @param publicKeyPem - trusted signing key.
   */
  constructor(
    private readonly repository: string,
    private readonly tagPrefix: string,
    private readonly publicKeyPem: string,
  ) {
    if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(repository)) {
      throw new Error(`invalid GitHub repository: ${repository}`)
    }
  }

  /**
   * Find the greatest signed stable runtime among recent releases.
   * @returns Latest candidate, or null when no runtime release exists.
   */
  async latest(): Promise<AvailableRuntimeRelease | null> {
    const url = `https://api.github.com/repos/${this.repository}/releases?per_page=30`
    const response = await fetch(url, { headers: githubHeaders() })
    if (!response.ok) throw new Error(`GitHub releases request failed with ${response.status}`)
    const releases = releasesSchema.parse(await response.json())
      .filter(release => !release.draft && !release.prerelease && release.tag_name.startsWith(this.tagPrefix))
    if (releases.length === 0) return null

    let latest: AvailableRuntimeRelease | null = null
    for (const release of releases) {
      const candidate = await resolveRelease(release, this.publicKeyPem)
      if (latest === null || compareRuntimeVersions(candidate.manifest, latest.manifest) > 0) latest = candidate
    }
    return latest
  }

  /**
   * Download a selected archive into a private random file.
   * @param release - signed release selected by {@link latest}.
   * @param directory - private desktop downloads directory.
   * @param onProgress - progress callback.
   * @param signal - cancellation signal.
   * @returns Completed archive path; partial files are removed on failure.
   */
  async download(
    release: AvailableRuntimeRelease,
    directory: string,
    onProgress: (progress: DownloadProgress) => void,
    signal: AbortSignal,
  ): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const filename = `${basename(release.manifest.asset)}.${randomBytes(6).toString('hex')}.download`
    const destination = join(directory, filename)
    const response = await fetch(release.archive.browser_download_url, { headers: githubHeaders(), signal })
    if (!response.ok || response.body === null) {
      throw new Error(`runtime archive download failed with ${response.status}`)
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null && Number(contentLength) !== release.manifest.size) {
      await response.body.cancel()
      throw new Error('runtime archive Content-Length disagrees with its signed size')
    }

    const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    const completion = finished(output)
    let received = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        received += result.value.byteLength
        if (received > release.manifest.size) {
          throw new Error(`runtime archive exceeded its signed size of ${release.manifest.size} bytes`)
        }
        if (!output.write(result.value)) await once(output, 'drain')
        onProgress({ received, total: release.manifest.size })
      }
      output.end()
      await completion
      if (received !== release.manifest.size) {
        throw new Error(`runtime archive ended at ${received} bytes; expected ${release.manifest.size}`)
      }
      return destination
    } catch (error) {
      try {
        await reader.cancel()
      } catch {
        // The primary transfer error remains authoritative.
      }
      output.destroy()
      try {
        await completion
      } catch {
        // The primary transfer error remains authoritative.
      }
      try {
        await unlink(destination)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
          throw new AggregateError([error, cleanupError], 'runtime download and cleanup both failed')
        }
      }
      throw error
    }
  }
}
