/** Window lifecycle helpers for a main window retained by a system tray. */

/** Minimum close event used by the tray lifecycle. */
export interface PreventableCloseEvent {
  /** Cancel destruction of the native window. */
  preventDefault(): void
}

/** BrowserWindow operations used by tray visibility behavior. */
export interface TrayManagedWindow {
  /** Whether the native window can no longer be used. */
  isDestroyed(): boolean
  /** Whether the native window is minimized. */
  isMinimized(): boolean
  /** Restore a minimized native window. */
  restore(): void
  /** Show a hidden native window. */
  show(): void
  /** Focus a visible native window. */
  focus(): void
  /** Hide the native window without destroying it. */
  hide(): void
  /** Subscribe to an impending native close. */
  on(event: 'close', listener: (event: PreventableCloseEvent) => void): unknown
  /** Remove a previously installed close listener. */
  removeListener(event: 'close', listener: (event: PreventableCloseEvent) => void): unknown
}

/**
 * Restore, show, and focus a retained main window.
 * @param window - tray-owned main window.
 * @returns false only after the native window has been destroyed.
 */
export function showTrayWindow(window: TrayManagedWindow): boolean {
  if (window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
}

/**
 * Convert ordinary close requests into hiding while allowing explicit exit.
 * @param window - main window retained by the tray.
 * @param shouldQuit - returns true during explicit exit, relaunch, or session end.
 * @param onFirstHide - one-shot notification after the first intercepted close.
 * @returns disposer for the close listener.
 */
export function installCloseToTray(
  window: TrayManagedWindow,
  shouldQuit: () => boolean,
  onFirstHide: () => void,
): () => void {
  let notified = false
  const onClose = (event: PreventableCloseEvent): void => {
    if (shouldQuit()) return
    event.preventDefault()
    window.hide()
    if (notified) return
    notified = true
    onFirstHide()
  }
  window.on('close', onClose)
  return () => { window.removeListener('close', onClose) }
}
