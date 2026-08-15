import { describe, expect, it, vi } from 'vitest'
import {
  type PreventableCloseEvent,
  type TrayManagedWindow,
  installCloseToTray,
  showTrayWindow,
} from '../src/tray-lifecycle.ts'

class FakeWindow implements TrayManagedWindow {
  destroyed = false
  minimized = false
  readonly focus = vi.fn()
  readonly hide = vi.fn()
  readonly restore = vi.fn(() => { this.minimized = false })
  readonly show = vi.fn()
  private closeListeners = new Set<(event: PreventableCloseEvent) => void>()

  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return this.minimized }
  on(_event: 'close', listener: (event: PreventableCloseEvent) => void): void { this.closeListeners.add(listener) }
  removeListener(_event: 'close', listener: (event: PreventableCloseEvent) => void): void {
    this.closeListeners.delete(listener)
  }
  close(event: PreventableCloseEvent): void {
    for (const listener of this.closeListeners) listener(event)
  }
}

describe('tray window lifecycle', () => {
  it('hides ordinary close requests and notifies only on the first hide', () => {
    const window = new FakeWindow()
    const notify = vi.fn()
    const dispose = installCloseToTray(window, () => false, notify)
    const first = { preventDefault: vi.fn() }
    const second = { preventDefault: vi.fn() }

    window.close(first)
    window.close(second)

    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(second.preventDefault).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledOnce()
    dispose()
    window.close({ preventDefault: vi.fn() })
    expect(window.hide).toHaveBeenCalledTimes(2)
  })

  it('allows explicit exit and session-end close requests to destroy the window', () => {
    const window = new FakeWindow()
    const event = { preventDefault: vi.fn() }
    installCloseToTray(window, () => true, vi.fn())

    window.close(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('restores, shows, and focuses a retained window', () => {
    const window = new FakeWindow()
    window.minimized = true

    expect(showTrayWindow(window)).toBe(true)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()

    window.destroyed = true
    expect(showTrayWindow(window)).toBe(false)
    expect(window.show).toHaveBeenCalledOnce()
  })
})
