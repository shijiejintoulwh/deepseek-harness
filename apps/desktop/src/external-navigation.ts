/** Explicit user-activation policy for links leaving the Harness runtime. */

/** IPC channel used only for trusted external-link activations. */
export const EXTERNAL_LINK_CHANNEL = 'dsh-desktop:open-external-link'

/** Minimal click information needed by the sandboxed preload policy. */
export interface ExternalLinkClick {
  readonly isTrusted: boolean
  readonly button: number
  /** Return the DOM event path from the activated node to the window. */
  composedPath(): readonly unknown[]
}

interface AnchorCandidate {
  readonly href: string
  readonly download?: string
}

function anchorCandidate(value: unknown): AnchorCandidate | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { tagName?: unknown; href?: unknown; download?: unknown }
  if (candidate.tagName !== 'A' || typeof candidate.href !== 'string') return null
  if (candidate.download !== undefined && typeof candidate.download !== 'string') return null
  return {
    href: candidate.href,
    ...(candidate.download === undefined ? {} : { download: candidate.download }),
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.startsWith('127.')
    || normalized === '[::1]'
    || normalized === '0.0.0.0'
}

/**
 * Resolve one external HTTP(S) target while rejecting runtime-local and unsafe URLs.
 *
 * @param rawUrl Candidate link URL.
 * @param documentUrl URL of the trusted Harness document.
 * @returns A normalized external URL, or `null` when the target must stay denied.
 */
export function externalHttpUrl(rawUrl: string, documentUrl: string): string | null {
  try {
    const document = new URL(documentUrl)
    const candidate = new URL(rawUrl, document)
    if (candidate.protocol !== 'https:' && candidate.protocol !== 'http:') return null
    if (candidate.origin === document.origin || isLoopbackHostname(candidate.hostname)) return null
    if (candidate.username !== '' || candidate.password !== '') return null
    return candidate.href
  } catch {
    // URL construction is the only operation in this block and malformed values stay denied.
    return null
  }
}

/**
 * Resolve an external link only from a trusted primary or middle-button activation.
 *
 * @param event Renderer click information.
 * @param documentUrl URL of the trusted Harness document.
 * @returns The normalized external URL to forward, or `null` when no link is eligible.
 */
export function externalLinkFromUserClick(event: ExternalLinkClick, documentUrl: string): string | null {
  if (!event.isTrusted || (event.button !== 0 && event.button !== 1)) return null
  for (const node of event.composedPath()) {
    const anchor = anchorCandidate(node)
    if (anchor === null) continue
    if (anchor.download !== undefined && anchor.download !== '') return null
    return externalHttpUrl(anchor.href, documentUrl)
  }
  return null
}
