/** Renderer for the sandboxed Harness update progress window. */

import type { RuntimeUpdateProgress } from './updater.ts'

declare global {
  interface Window {
    /** Render a trusted progress event supplied by the main process. */
    renderUpdateProgress: (progress: RuntimeUpdateProgress) => void
  }
}

const status = document.querySelector<HTMLElement>('[data-update-status]')
const detail = document.querySelector<HTMLElement>('[data-update-detail]')
const progressBar = document.querySelector<HTMLProgressElement>('progress')
if (status === null || detail === null || progressBar === null) {
  throw new Error('update window is missing required elements')
}

window.renderUpdateProgress = (progress): void => {
  if (progress.phase === 'downloading') {
    const percent = Math.floor(progress.progress.received / progress.progress.total * 100)
    status.textContent = '正在下载 Harness 运行时'
    detail.textContent = `${percent}%`
    progressBar.removeAttribute('indeterminate')
    progressBar.value = percent
    return
  }
  if (progress.phase === 'verifying') {
    status.textContent = '正在验证签名并安装'
    detail.textContent = '当前版本仍可继续回滚'
    progressBar.removeAttribute('value')
    progressBar.setAttribute('indeterminate', '')
    return
  }
  status.textContent = '更新已准备完成'
  detail.textContent = progress.runtimeId
  progressBar.removeAttribute('indeterminate')
  progressBar.value = 100
}
