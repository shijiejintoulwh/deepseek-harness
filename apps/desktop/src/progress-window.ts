/** Small sandboxed update window controlled only by numeric main-process calls. */

import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { RuntimeUpdateProgress } from './updater.ts'

/** User-visible progress window for one runtime download and verification. */
export class UpdateProgressWindow {
  private readonly window: BrowserWindow
  private ready = false
  private latest: RuntimeUpdateProgress | null = null

  /**
   * @param appPath - packaged application root containing `ui/update.html`.
   * @param parent - main Harness window.
   * @param onCancel - cancellation request owned by the updater.
   */
  constructor(appPath: string, parent: BrowserWindow, onCancel: () => void) {
    this.window = new BrowserWindow({
      width: 460,
      height: 230,
      parent,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      title: '更新 DeepSeek Harness',
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
  setProgress(progress: RuntimeUpdateProgress): void {
    this.latest = progress
    if (progress.phase === 'downloading') {
      this.window.setProgressBar(progress.progress.received / progress.progress.total)
    } else if (progress.phase === 'staged') {
      this.window.setProgressBar(1)
    } else {
      this.window.setProgressBar(2)
    }
    if (this.ready) void this.render(progress)
  }

  /** Close the update window and clear taskbar progress. */
  close(): void {
    this.window.setProgressBar(-1)
    if (!this.window.isDestroyed()) this.window.close()
  }

  /** Call a fixed renderer function with JSON-encoded trusted data. */
  private async render(progress: RuntimeUpdateProgress): Promise<void> {
    await this.window.webContents.executeJavaScript(`window.renderUpdateProgress(${JSON.stringify(progress)})`)
  }
}
