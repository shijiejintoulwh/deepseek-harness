/** Renderer for the sandboxed Harness update progress window. */

import type { UpdateProgressPresentation } from './progress-window.ts'

declare global {
  interface Window {
    /** Render a trusted progress event supplied by the main process. */
    renderUpdateProgress: (progress: UpdateProgressPresentation) => void
  }
}

const status = document.querySelector<HTMLElement>('[data-update-status]')
const detail = document.querySelector<HTMLElement>('[data-update-detail]')
const progressBar = document.querySelector<HTMLProgressElement>('progress')
if (status === null || detail === null || progressBar === null) {
  throw new Error('update window is missing required elements')
}

window.renderUpdateProgress = (progress): void => {
  status.textContent = progress.status
  detail.textContent = progress.detail
  if (progress.phase === 'progress') {
    progressBar.removeAttribute('indeterminate')
    progressBar.value = Math.floor(progress.fraction * 100)
    return
  }
  if (progress.phase === 'indeterminate') {
    progressBar.removeAttribute('value')
    progressBar.setAttribute('indeterminate', '')
    return
  }
  progressBar.removeAttribute('indeterminate')
  progressBar.value = 100
}
