import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const desktopRoot = join(import.meta.dirname, '..')

describe('desktop Windows branding', () => {
  it('uses the branded icon for packaged Windows surfaces', async () => {
    const config = (await readFile(join(desktopRoot, 'electron-builder.yml'), 'utf8')).replaceAll('\r\n', '\n')

    expect(config).toContain('  - from: build/icon.ico\n    to: icon.ico')
    expect(config).toContain('win:\n  icon: build/icon.ico')
    expect(config).toContain('  installerIcon: build/icon.ico')
    expect(config).toContain('  uninstallerIcon: build/icon.ico')
    expect(config).toContain('  installerHeaderIcon: build/icon.ico')
  })

  it('contains the standard Windows icon sizes', async () => {
    const icon = await readFile(join(desktopRoot, 'build', 'icon.ico'))
    expect(icon.readUInt16LE(0)).toBe(0)
    expect(icon.readUInt16LE(2)).toBe(1)
    const count = icon.readUInt16LE(4)
    const sizes = Array.from({ length: count }, (_, index) => {
      const entry = 6 + index * 16
      const widthByte = icon.readUInt8(entry)
      const heightByte = icon.readUInt8(entry + 1)
      const width = widthByte === 0 ? 256 : widthByte
      const height = heightByte === 0 ? 256 : heightByte
      expect(width).toBe(height)
      expect(icon.readUInt32LE(entry + 12) + icon.readUInt32LE(entry + 8)).toBeLessThanOrEqual(icon.length)
      return width
    })
    expect(sizes.toSorted((left, right) => left - right)).toEqual([16, 24, 32, 48, 64, 128, 256])
  })
})
