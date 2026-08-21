/** Small sandboxed update window controlled only by trusted main-process calls. */

import { BrowserWindow } from 'electron'
import { join } from 'node:path'

/** Trusted presentation state for one runtime or desktop-shell update. */
export type UpdateProgressPresentation =
  | {
    readonly phase: 'progress'
    readonly status: string
    readonly detail: string
    readonly fraction: number
  }
  | {
    readonly phase: 'indeterminate'
    readonly status: string
    readonly detail: string
  }
  | {
    readonly phase: 'complete'
    readonly status: string
    readonly detail: string
  }

/** User-visible progress window for one update download and verification. */
export class UpdateProgressWindow {
  private readonly window: BrowserWindow
  private ready = false
  private closing = false
  private latest: UpdateProgressPresentation | null = null

  /**
   * @param appPath - packaged application root containing `ui/update.html`.
   * @param parent - main Harness window.
   * @param onCancel - cancellation request owned by the updater.
   * @param title - native window title naming the update target.
   */
  constructor(appPath: string, parent: BrowserWindow, onCancel: () => void, title = '更新 DeepSeek Harness') {
    this.window = new BrowserWindow({
      width: 460,
      height: 230,
      parent,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      title,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    this.window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (url === 'dsh-desktop://cancel/') onCancel()
    })
    this.window.on('close', (event) => {
      if (this.closing) return
      event.preventDefault()
      onCancel()
    })
    this.window.webContents.once('did-finish-load', () => {
      this.ready = true
      if (this.latest !== null) void this.render(this.latest)
      this.window.show()
    })
    void this.window.loadFile(join(appPath, 'ui', 'update.html'))
  }

  /**
   * Present one trusted progress value.
   * @param progress - updater progress event.
   */
  setProgress(progress: UpdateProgressPresentation): void {
    this.latest = progress
    if (progress.phase === 'progress') {
      this.window.setProgressBar(progress.fraction)
    } else if (progress.phase === 'complete') {
      this.window.setProgressBar(1)
    } else {
      this.window.setProgressBar(2)
    }
    if (this.ready) void this.render(progress)
  }

  /** Close the update window and clear taskbar progress. */
  close(): void {
    this.closing = true
    if (this.window.isDestroyed()) return
    this.window.setProgressBar(-1)
    this.window.close()
  }

  /** Call a fixed renderer function with JSON-encoded trusted data. */
  private async render(progress: UpdateProgressPresentation): Promise<void> {
    await this.window.webContents.executeJavaScript(`window.renderUpdateProgress(${JSON.stringify(progress)})`)
  }
}
