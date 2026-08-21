/** Sandboxed bridge for Harness theme reports and trusted external-link activations. */

import { ipcRenderer } from 'electron'
import {
  EXTERNAL_LINK_CHANNEL,
  externalLinkFromUserClick,
} from './external-navigation.ts'
import {
  readShellTheme,
  RUNTIME_DARK_THEME_ATTRIBUTE,
  RUNTIME_THEME_PREFERENCE_ATTRIBUTE,
  SHELL_THEME_CHANNEL,
} from './shell-theme.ts'

function installExternalLinkForwarder(): void {
  const forward = (event: MouseEvent): void => {
    const url = externalLinkFromUserClick(event, window.location.href)
    if (url === null) return
    event.preventDefault()
    ipcRenderer.send(EXTERNAL_LINK_CHANNEL, url)
  }
  window.addEventListener('click', forward, { capture: true })
  window.addEventListener('auxclick', forward, { capture: true })
  window.addEventListener('pagehide', () => {
    window.removeEventListener('click', forward, { capture: true })
    window.removeEventListener('auxclick', forward, { capture: true })
  }, { once: true })
}

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

installExternalLinkForwarder()

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', installThemeObserver, { once: true })
} else {
  installThemeObserver()
}
