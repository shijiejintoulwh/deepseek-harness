import { describe, expect, it } from 'vitest'
import {
  externalHttpUrl,
  externalLinkFromUserClick,
  type ExternalLinkClick,
} from '../src/external-navigation.ts'

const runtimeUrl = 'http://127.0.0.1:3080/session'

function click(
  path: readonly unknown[],
  options: { trusted?: boolean; button?: number } = {},
): ExternalLinkClick {
  return {
    isTrusted: options.trusted ?? true,
    button: options.button ?? 0,
    composedPath: () => path,
  }
}

describe('desktop external navigation policy', () => {
  it('normalizes explicit external HTTP and HTTPS destinations', () => {
    expect(externalHttpUrl('https://example.com/docs?q=1', runtimeUrl))
      .toBe('https://example.com/docs?q=1')
    expect(externalHttpUrl('http://example.com', runtimeUrl)).toBe('http://example.com/')
  })

  it('keeps same-origin and loopback destinations inside the desktop policy', () => {
    expect(externalHttpUrl('/settings', runtimeUrl)).toBeNull()
    expect(externalHttpUrl('http://127.0.0.1:4090/other', runtimeUrl)).toBeNull()
    expect(externalHttpUrl('http://localhost:3080/', runtimeUrl)).toBeNull()
    expect(externalHttpUrl('http://[::1]:3080/', runtimeUrl)).toBeNull()
  })

  it('rejects non-web, credential-bearing, and malformed destinations', () => {
    expect(externalHttpUrl('javascript:alert(1)', runtimeUrl)).toBeNull()
    expect(externalHttpUrl('file:///C:/Windows/System32', runtimeUrl)).toBeNull()
    expect(externalHttpUrl('https://user:secret@example.com/', runtimeUrl)).toBeNull()
    expect(externalHttpUrl('https://[', runtimeUrl)).toBeNull()
  })

  it('accepts only trusted primary or middle-button activations on external anchors', () => {
    const anchor = { tagName: 'A', href: 'https://github.com/deepseek-ai/DeepSeek-V3' }
    expect(externalLinkFromUserClick(click([{ tagName: 'SPAN' }, anchor]), runtimeUrl))
      .toBe('https://github.com/deepseek-ai/DeepSeek-V3')
    expect(externalLinkFromUserClick(click([anchor], { button: 1 }), runtimeUrl))
      .toBe('https://github.com/deepseek-ai/DeepSeek-V3')
    expect(externalLinkFromUserClick(click([anchor], { trusted: false }), runtimeUrl)).toBeNull()
    expect(externalLinkFromUserClick(click([anchor], { button: 2 }), runtimeUrl)).toBeNull()
  })

  it('leaves downloads, same-origin links, and non-links to the renderer policy', () => {
    expect(externalLinkFromUserClick(click([{
      tagName: 'A',
      href: 'https://example.com/archive.zip',
      download: 'archive.zip',
    }]), runtimeUrl)).toBeNull()
    expect(externalLinkFromUserClick(click([{
      tagName: 'A',
      href: 'http://127.0.0.1:3080/settings',
    }]), runtimeUrl)).toBeNull()
    expect(externalLinkFromUserClick(click([{ tagName: 'BUTTON' }]), runtimeUrl)).toBeNull()
  })
})
