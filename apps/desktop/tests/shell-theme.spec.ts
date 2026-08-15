import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseShellThemeReport,
  readShellTheme,
  RUNTIME_DARK_THEME_ATTRIBUTE,
  RUNTIME_THEME_PREFERENCE_ATTRIBUTE,
  shellBackgroundColor,
} from '../src/shell-theme.ts'

function body(attributes: Record<string, string>): Pick<HTMLElement, 'getAttribute' | 'hasAttribute'> {
  return {
    getAttribute: name => attributes[name] ?? null,
    hasAttribute: name => Object.hasOwn(attributes, name),
  }
}

describe('desktop shell theme contract', () => {
  it('observes the attributes published by the runtime theme presenter', async () => {
    const presenter = await readFile(join(
      import.meta.dirname,
      '..', '..', '..',
      'packages', 'client', 'ui-layout', 'src', 'client', 'theme-presenter.ts',
    ), 'utf8')

    expect(presenter).toContain(`export const DARK_ATTRIBUTE = '${RUNTIME_DARK_THEME_ATTRIBUTE}'`)
    expect(presenter).toContain(`export const THEME_PREFERENCE_ATTRIBUTE = '${RUNTIME_THEME_PREFERENCE_ATTRIBUTE}'`)
  })

  it('preserves system preference while reporting the resolved dark palette', () => {
    expect(readShellTheme(body({
      [RUNTIME_DARK_THEME_ATTRIBUTE]: '',
      [RUNTIME_THEME_PREFERENCE_ATTRIBUTE]: 'system',
    }))).toEqual({ source: 'system', colorScheme: 'dark' })
  })

  it('uses the resolved palette for explicit, custom, and legacy preferences', () => {
    expect(readShellTheme(body({ [RUNTIME_THEME_PREFERENCE_ATTRIBUTE]: 'light' })))
      .toEqual({ source: 'light', colorScheme: 'light' })
    expect(readShellTheme(body({
      [RUNTIME_DARK_THEME_ATTRIBUTE]: '',
      [RUNTIME_THEME_PREFERENCE_ATTRIBUTE]: 'custom-dark',
    }))).toEqual({ source: 'dark', colorScheme: 'dark' })
    expect(readShellTheme(body({ [RUNTIME_DARK_THEME_ATTRIBUTE]: '' })))
      .toEqual({ source: 'dark', colorScheme: 'dark' })
  })

  it('accepts only exact reports with a coherent explicit source', () => {
    expect(parseShellThemeReport({ source: 'system', colorScheme: 'light' }))
      .toEqual({ source: 'system', colorScheme: 'light' })
    expect(parseShellThemeReport({ source: 'dark', colorScheme: 'dark' }))
      .toEqual({ source: 'dark', colorScheme: 'dark' })
    expect(parseShellThemeReport({ source: 'light', colorScheme: 'dark' })).toBeNull()
    expect(parseShellThemeReport({ source: 'dark', colorScheme: 'dark', extra: true })).toBeNull()
    expect(parseShellThemeReport(['dark'])).toBeNull()
    expect(parseShellThemeReport(null)).toBeNull()
  })

  it('matches BrowserWindow backgrounds to the Harness base palette', () => {
    expect(shellBackgroundColor('light')).toBe('#ffffff')
    expect(shellBackgroundColor('dark')).toBe('#151517')
  })
})
