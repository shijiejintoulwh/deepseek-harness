/** Renderer-to-main values for keeping native Electron chrome on the Harness theme. */

/** IPC channel carrying the resolved renderer theme to the desktop host. */
export const SHELL_THEME_CHANNEL = 'dsh-desktop:shell-theme'

/** Runtime-owned body attribute selecting the dark design-token palette. */
export const RUNTIME_DARK_THEME_ATTRIBUTE = 'data-ds-dark-theme'

/** Runtime-owned body attribute exposing the persisted theme preference. */
export const RUNTIME_THEME_PREFERENCE_ATTRIBUTE = 'data-ds-theme-preference'

/** Electron theme sources accepted across the sandboxed IPC channel. */
export type ShellThemeSource = 'system' | 'light' | 'dark'

/** Resolved palette and native theme source reported by the Harness renderer. */
export interface ShellThemeReport {
  /** Source assigned to Electron's nativeTheme. */
  source: ShellThemeSource
  /** Palette currently painted by the renderer. */
  colorScheme: 'light' | 'dark'
}

const BACKGROUND_COLORS = Object.freeze({
  light: '#ffffff',
  dark: '#151517',
})

/**
 * Read the current Harness palette and preference from its body attributes.
 * Runtimes without the preference attribute fall back to the resolved palette.
 * @param body - Harness document body.
 * @returns report suitable for the fixed desktop IPC channel.
 */
export function readShellTheme(body: Pick<HTMLElement, 'getAttribute' | 'hasAttribute'>): ShellThemeReport {
  const colorScheme = body.hasAttribute(RUNTIME_DARK_THEME_ATTRIBUTE) ? 'dark' : 'light'
  const source = body.getAttribute(RUNTIME_THEME_PREFERENCE_ATTRIBUTE) === 'system'
    ? 'system'
    : colorScheme
  return { source, colorScheme }
}

/**
 * Validate a renderer value before it reaches native Electron appearance APIs.
 * @param value - untrusted IPC payload.
 * @returns a copied report, or null when fields or their relationship are invalid.
 */
export function parseShellThemeReport(value: unknown): ShellThemeReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2) return null
  const source = record.source
  const colorScheme = record.colorScheme
  if (source !== 'system' && source !== 'light' && source !== 'dark') return null
  if (colorScheme !== 'light' && colorScheme !== 'dark') return null
  if (source !== 'system' && source !== colorScheme) return null
  return { source, colorScheme }
}

/**
 * Return the BrowserWindow background matching the renderer's base palette.
 * @param colorScheme - validated renderer palette.
 * @returns opaque CSS color for BrowserWindow.
 */
export function shellBackgroundColor(colorScheme: ShellThemeReport['colorScheme']): string {
  return BACKGROUND_COLORS[colorScheme]
}
