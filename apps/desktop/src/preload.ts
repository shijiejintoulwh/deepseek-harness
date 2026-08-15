/** Sandboxed DOM observer that reports Harness theme semantics to the main process. */

import { ipcRenderer } from 'electron'
import {
  readShellTheme,
  RUNTIME_DARK_THEME_ATTRIBUTE,
  RUNTIME_THEME_PREFERENCE_ATTRIBUTE,
  SHELL_THEME_CHANNEL,
} from './shell-theme.ts'

function installThemeObserver(): void {
  const body = document.body
  const publish = (): void => {
    ipcRenderer.send(SHELL_THEME_CHANNEL, readShellTheme(body))
  }
  publish()
  const observer = new MutationObserver(publish)
  observer.observe(body, {
    attributes: true,
    attributeFilter: [RUNTIME_DARK_THEME_ATTRIBUTE, RUNTIME_THEME_PREFERENCE_ATTRIBUTE],
  })
  window.addEventListener('pagehide', () => { observer.disconnect() }, { once: true })
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', installThemeObserver, { once: true })
} else {
  installThemeObserver()
}
