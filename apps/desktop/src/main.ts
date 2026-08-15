/**
 * Electron host for the independently versioned Harness runtime. It owns only
 * installation, selection, child-process lifecycle, and native update UX; the
 * served application remains the ordinary `dsh web` composition.
 */

import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
  shell,
  Tray,
} from 'electron'
import {
  DESKTOP_PROTOCOL_VERSION,
  MAX_PENDING_LAUNCH_FAILURES,
  PENDING_RUNTIME_STABILITY_MS,
  RUNTIME_MANIFEST_PUBLIC_KEY_PEM,
  RUNTIME_RELEASE_REPOSITORY,
  RUNTIME_RELEASE_TAG_PREFIX,
  RUNTIME_START_TIMEOUT_MS,
} from './config.ts'
import { GitHubRuntimeProvider } from './github-provider.ts'
import {
  canBackupHarnessHome,
  canImportHarnessHome,
  importHarnessHomeWithBackup,
  legacyHarnessHome,
  pathExists,
} from './home-import.ts'
import { UpdateProgressWindow } from './progress-window.ts'
import { launchRuntime, type RunningRuntime } from './runtime-process.ts'
import {
  commitPendingRuntime,
  recordPendingFailure,
  rollbackRuntime,
  runtimeId,
  selectedRuntimeId,
  type RuntimeState,
} from './runtime-model.ts'
import { RuntimeStore } from './runtime-store.ts'
import { parseShellThemeReport, shellBackgroundColor, SHELL_THEME_CHANNEL } from './shell-theme.ts'
import { installCloseToTray, showTrayWindow } from './tray-lifecycle.ts'
import { describeUpdateFailure } from './update-error.ts'
import { RuntimeUpdater, type RuntimeUpdateCheck } from './updater.ts'

const PRODUCT_DIRECTORY = 'DeepSeekHarnessDesktop'
const HOME_IMPORT_DECISION = 'home-import-decision-v1.json'
const SHELL_THEME_START_TIMEOUT_MS = 5_000
const SESSION_END_CLOSE_WINDOW_MS = 30_000
const originalEnvironment = { ...process.env }
const smokeTest = process.env.DSH_DESKTOP_SMOKE_TEST === '1'
const smokeDataRoot = smokeTest ? process.env.DSH_DESKTOP_SMOKE_DATA_ROOT : undefined
const smokeImportHome = smokeTest ? process.env.DSH_DESKTOP_SMOKE_IMPORT_HOME : undefined
if (smokeTest && (smokeDataRoot === undefined || smokeDataRoot === '')) {
  throw new Error('DSH_DESKTOP_SMOKE_DATA_ROOT is required in desktop smoke-test mode')
}
app.setName('DeepSeek Harness Desktop')
app.setPath('userData', smokeDataRoot === undefined
  ? join(app.getPath('appData'), PRODUCT_DIRECTORY)
  : join(resolve(smokeDataRoot), 'user-data'))

let mainWindow: BrowserWindow | null = null
let runningRuntime: RunningRuntime | null = null
let runtimeStore: RuntimeStore | null = null
let runtimeUpdater: RuntimeUpdater | null = null
let runtimeState: RuntimeState | null = null
let runtimeLog: WriteStream | null = null
let desktopTray: Tray | null = null
let removeCloseToTray: (() => void) | null = null
let sessionEndReset: ReturnType<typeof setTimeout> | null = null
let sessionEnding = false
let quitting = false
let updateInProgress = false

/** Return a Windows local-data root without making the install directory writable. */
function localDataRoot(): string {
  if (smokeDataRoot !== undefined) return join(resolve(smokeDataRoot), 'runtime-data')
  const local = process.env.LOCALAPPDATA
  return resolve(local === undefined || local === '' ? app.getPath('userData') : local, PRODUCT_DIRECTORY)
}

/** Write runtime output to the private desktop log. */
function writeRuntimeOutput(stream: 'stdout' | 'stderr', text: string): void {
  runtimeLog?.write(`[${new Date().toISOString()}] [${stream}] ${text}`)
}

/** Flush and close the runtime log before the host exits. */
async function closeRuntimeLog(): Promise<void> {
  const log = runtimeLog
  runtimeLog = null
  if (log === null) return
  log.end()
  await finished(log)
}

/** Reach child-process and log quiescence before exiting or relaunching. */
async function quiesceDesktop(): Promise<void> {
  if (runningRuntime !== null) {
    await runningRuntime.stop()
    runningRuntime = null
  }
  await closeRuntimeLog()
}

/** Resolve the seed bundle packaged beside Electron. */
function seedRuntimeDirectory(): string {
  const override = process.env.DSH_DESKTOP_SEED_DIR
  if (!app.isPackaged && override !== undefined && override !== '') return resolve(override)
  return join(process.resourcesPath, 'seed-runtime')
}

/** Resolve the branded icon embedded beside the packaged application. */
function desktopIconPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'icon.ico')
  return join(import.meta.dirname, '..', 'build', 'icon.ico')
}

/** Restore the retained main window from the tray or a second launch. */
function showMainWindow(): void {
  if (mainWindow !== null) showTrayWindow(mainWindow)
}

/** Destroy tray-owned listeners and native resources immediately before exit. */
function destroyTray(): void {
  if (sessionEndReset !== null) clearTimeout(sessionEndReset)
  sessionEndReset = null
  sessionEnding = false
  removeCloseToTray?.()
  removeCloseToTray = null
  if (desktopTray !== null && !desktopTray.isDestroyed()) desktopTray.destroy()
  desktopTray = null
}

/** Install the Windows notification-area entry and close-to-tray behavior. */
function installTray(window: BrowserWindow): void {
  if (desktopTray !== null) throw new Error('desktop tray is already installed')
  const nextTray = new Tray(desktopIconPath())
  const show = (): void => { showTrayWindow(window) }
  try {
    nextTray.setToolTip('DeepSeek Harness Desktop')
    nextTray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 DeepSeek Harness', click: show },
      { label: '检查 Harness 更新', click: () => { show(); void checkForUpdates(true) } },
      { type: 'separator' },
      { label: '退出', click: () => { app.quit() } },
    ]))
    nextTray.on('click', show)
    nextTray.on('balloon-click', show)
    removeCloseToTray = installCloseToTray(window, () => quitting || sessionEnding, () => {
      if (smokeTest) return
      nextTray.displayBalloon({
        icon: desktopIconPath(),
        iconType: 'custom',
        title: 'DeepSeek Harness 仍在运行',
        content: '窗口已隐藏到系统托盘。右键托盘图标并选择“退出”可完全关闭。',
        noSound: true,
        respectQuietTime: true,
      })
    })
    desktopTray = nextTray
  } catch (error) {
    removeCloseToTray?.()
    removeCloseToTray = null
    nextTray.destroy()
    throw error
  }
  window.on('query-session-end', () => {
    sessionEnding = true
    if (sessionEndReset !== null) clearTimeout(sessionEndReset)
    sessionEndReset = setTimeout(() => {
      sessionEndReset = null
      sessionEnding = false
    }, SESSION_END_CLOSE_WINDOW_MS)
  })
}

/** Import a legacy home after consent, or from the isolated smoke fixture. */
async function prepareHarnessHome(): Promise<{ harnessHome: string; agentsHome: string }> {
  const desktopHome = join(app.getPath('userData'), 'dsh-home')
  const agentsHome = join(app.getPath('userData'), 'agents-home')
  if (smokeImportHome !== undefined && smokeImportHome !== '') {
    await importHarnessHomeWithBackup(resolve(smokeImportHome), desktopHome)
  } else if (!smokeTest && !await pathExists(join(app.getPath('userData'), HOME_IMPORT_DECISION))) {
    const legacy = legacyHarnessHome(originalEnvironment)
    if (legacy !== desktopHome && await pathExists(legacy)) {
      const importable = await canImportHarnessHome(desktopHome)
      const backupable = !importable && await canBackupHarnessHome(desktopHome)
      if (importable || backupable) {
        const choice = await dialog.showMessageBox({
          type: 'question',
          title: '导入 DeepSeek Harness 数据',
          message: backupable ? '检测到现有 CLI 配置和桌面版数据' : '检测到现有的 DeepSeek Harness 配置',
          detail: backupable
            ? `是否先备份当前桌面版数据，再从 ${legacy} 导入？原目录和备份都不会被修改；node_modules 等可重建依赖不会复制。`
            : `是否复制 ${legacy} 到桌面版的独立数据目录？原目录不会被修改；node_modules 等可重建依赖不会复制。`,
          buttons: backupable ? ['备份并导入', '保留当前桌面数据'] : ['导入', '使用全新配置'],
          defaultId: 0,
          cancelId: 1,
        })
        if (choice.response === 0) {
          const backup = await importHarnessHomeWithBackup(legacy, desktopHome)
          await writeFile(
            join(app.getPath('userData'), HOME_IMPORT_DECISION),
            `${JSON.stringify({ decision: 'imported', backup })}\n`,
            { flag: 'wx', mode: 0o600 },
          )
          if (backup !== null) {
            await dialog.showMessageBox({
              type: 'info',
              title: 'DeepSeek Harness 数据导入完成',
              message: '现有 CLI 配置已导入',
              detail: `原桌面版数据已备份到：\n${backup}`,
            })
          }
        } else {
          await writeFile(
            join(app.getPath('userData'), HOME_IMPORT_DECISION),
            `${JSON.stringify({ decision: 'kept-desktop-data', backup: null })}\n`,
            { flag: 'wx', mode: 0o600 },
          )
        }
      }
    }
  }
  await mkdir(desktopHome, { recursive: true, mode: 0o700 })
  await mkdir(agentsHome, { recursive: true, mode: 0o700 })
  return { harnessHome: desktopHome, agentsHome }
}

/** Install the signed offline seed when no runtime selection exists. */
async function ensureSeedRuntime(store: RuntimeStore, state: RuntimeState): Promise<RuntimeState> {
  if (state.active !== null) return state
  const bundle = await store.readReleaseBundle(seedRuntimeDirectory())
  const installed = await store.install(bundle)
  const seeded: RuntimeState = { ...state, active: installed.id, pendingFailures: 0 }
  await store.writeState(seeded)
  return seeded
}

/** Launch the selected candidate, retry it once, then fall back to active. */
async function startSelectedRuntime(
  store: RuntimeStore,
  initialState: RuntimeState,
  harnessHome: string,
  agentsHome: string,
): Promise<{ runtime: RunningRuntime; state: RuntimeState; selectedId: string }> {
  let state = initialState
  for (;;) {
    const selected = selectedRuntimeId(state)
    if (selected === null) throw new Error('no Harness runtime is selected')
    try {
      const runtime = await launchRuntime({
        runtimeDirectory: store.runtimeDirectory(selected),
        harnessHome,
        agentsHome,
        timeoutMs: RUNTIME_START_TIMEOUT_MS,
        onOutput: writeRuntimeOutput,
      })
      return { runtime, state, selectedId: selected }
    } catch (error) {
      if (state.pending === null) throw error
      state = recordPendingFailure(state, MAX_PENDING_LAUNCH_FAILURES)
      await store.writeState(state)
    }
  }
}

/** Keep all navigation inside the loopback Harness origin or an external browser. */
function applyNavigationPolicy(window: BrowserWindow, runtimeUrl: string): void {
  const runtimeOrigin = new URL(runtimeUrl).origin
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const candidate = new URL(url)
      if (candidate.protocol === 'https:' || candidate.protocol === 'http:') void shell.openExternal(candidate.href)
    } catch {
      // A malformed renderer URL is denied by the handler's fixed response.
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    try {
      const candidate = new URL(url)
      if (candidate.origin === runtimeOrigin) return
      event.preventDefault()
      if (candidate.protocol === 'https:' || candidate.protocol === 'http:') void shell.openExternal(candidate.href)
    } catch {
      event.preventDefault()
    }
  })
}

/** Keep Electron-rendered Windows chrome aligned with the trusted Harness page. */
function installShellThemeSync(window: BrowserWindow): Promise<void> {
  let resolveFirstReport: (() => void) | null = null
  const firstReport = new Promise<void>((resolveFirst) => {
    resolveFirstReport = resolveFirst
  })
  const onTheme = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender !== window.webContents) return
    const report = parseShellThemeReport(value)
    if (report === null) return
    nativeTheme.themeSource = report.source
    window.setBackgroundColor(shellBackgroundColor(report.colorScheme))
    resolveFirstReport?.()
    resolveFirstReport = null
  }
  ipcMain.on(SHELL_THEME_CHANNEL, onTheme)
  window.once('closed', () => {
    ipcMain.removeListener(SHELL_THEME_CHANNEL, onTheme)
  })
  return firstReport
}

/** Create the secure main window for the ordinary Harness Web UI. */
async function createMainWindow(runtimeUrl: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: shellBackgroundColor(nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    title: 'DeepSeek Harness',
    icon: desktopIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      webSecurity: true,
    },
  })
  applyNavigationPolicy(window, runtimeUrl)
  const themeReady = installShellThemeSync(window)
  await window.loadURL(runtimeUrl)
  await Promise.race([
    themeReady,
    delay(SHELL_THEME_START_TIMEOUT_MS).then(() => {
      throw new Error('Harness page did not report its theme before the desktop startup timeout')
    }),
  ])
  if (!smokeTest) window.show()
  return window
}

/** Commit a pending candidate only after it remains live for the stability interval. */
async function settlePendingRuntime(selectedId: string, runtime: RunningRuntime): Promise<void> {
  const store = runtimeStore
  const state = runtimeState
  if (store === null || state === null || state.pending !== selectedId) return
  const survived = await Promise.race([
    runtime.done.then(() => false),
    delay(PENDING_RUNTIME_STABILITY_MS).then(() => true),
  ])
  if (!survived) {
    const latest = await store.readState()
    if (latest.pending === selectedId) {
      runtimeState = recordPendingFailure(latest, MAX_PENDING_LAUNCH_FAILURES)
      await store.writeState(runtimeState)
    }
    return
  }
  if (quitting) return
  const latest = await store.readState()
  if (latest.pending !== selectedId) return
  runtimeState = commitPendingRuntime(latest)
  await store.writeState(runtimeState)
  await store.prune(runtimeState)
}

/** Relaunch after the exact child process reaches quiescence. */
async function relaunchDesktop(): Promise<void> {
  quitting = true
  try {
    await quiesceDesktop()
  } catch (error) {
    quitting = false
    throw error
  }
  destroyTray()
  app.relaunch()
  app.exit(0)
}

/** Present one check result and install only after explicit consent. */
async function handleUpdateCheck(check: RuntimeUpdateCheck, manual: boolean): Promise<void> {
  const window = mainWindow
  const updater = runtimeUpdater
  const store = runtimeStore
  const state = runtimeState
  if (window === null || updater === null || store === null || state === null) return

  if (check.kind === 'none') {
    if (manual) await dialog.showMessageBox(window, { type: 'info', message: '当前 Harness 已是最新版本' })
    return
  }
  if (check.kind === 'skipped' && !manual) return
  if (check.kind === 'desktop-required') {
    const answer = await dialog.showMessageBox(window, {
      type: 'warning',
      message: '新的 Harness 需要更新桌面壳',
      detail: `运行时要求桌面版 ${check.release.manifest.minDesktopVersion} 或更高版本。`,
      buttons: ['打开 Releases', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if (answer.response === 0) {
      await shell.openExternal(`https://github.com/${RUNTIME_RELEASE_REPOSITORY}/releases`)
    }
    return
  }

  const release = check.release
  const version = runtimeId(release.manifest)
  const answer = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Harness 更新可用',
    message: `发现 Harness ${version}`,
    detail: '更新只替换 Harness 运行时；当前版本会保留用于回滚。',
    buttons: ['立即更新', '稍后提醒', '跳过此版本'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer.response === 2) {
    runtimeState = { ...state, skipped: version }
    await store.writeState(runtimeState)
    return
  }
  if (answer.response !== 0) return

  updateInProgress = true
  const controller = new AbortController()
  const progress = new UpdateProgressWindow(app.getAppPath(), window, () => {
    controller.abort()
  })
  try {
    runtimeState = await updater.install(release, await store.readState(), (value) => {
      progress.setProgress(value)
    }, controller.signal)
    progress.close()
    const restart = await dialog.showMessageBox(window, {
      type: 'info',
      message: 'Harness 更新已经准备完成',
      detail: '重启后将验证新版本；启动失败时会自动回滚。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (restart.response === 0) await relaunchDesktop()
  } catch (error) {
    progress.close()
    if (!controller.signal.aborted) {
      await dialog.showMessageBox(window, {
        type: 'error',
        message: 'Harness 更新失败',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  } finally {
    updateInProgress = false
  }
}

/** Check the release feed once; concurrent startup and manual checks collapse. */
async function checkForUpdates(manual: boolean): Promise<void> {
  const updater = runtimeUpdater
  const store = runtimeStore
  if (updateInProgress || updater === null || store === null || runtimeState === null) return
  updateInProgress = true
  try {
    const check = await updater.check(await store.readState())
    await handleUpdateCheck(check, manual)
  } catch (error) {
    if (manual && mainWindow !== null) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: '无法检查 Harness 更新',
        detail: describeUpdateFailure(error),
      })
    }
  } finally {
    updateInProgress = false
  }
}

/** Roll back to the retained previous runtime after explicit confirmation. */
async function requestRollback(): Promise<void> {
  const store = runtimeStore
  const window = mainWindow
  if (store === null || window === null) return
  const state = await store.readState()
  if (state.previous === null) {
    await dialog.showMessageBox(window, { type: 'info', message: '没有可回退的 Harness 版本' })
    return
  }
  const answer = await dialog.showMessageBox(window, {
    type: 'warning',
    message: `回退到 Harness ${state.previous}？`,
    detail: '会话和配置不会回退。',
    buttons: ['回退并重启', '取消'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer.response !== 0) return
  runtimeState = rollbackRuntime(state)
  await store.writeState(runtimeState)
  await relaunchDesktop()
}

/** Install the application menu after runtime services are ready. */
function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查 Harness 更新', click: () => void checkForUpdates(true) },
        { label: '回退 Harness 版本', click: () => void requestRollback() },
        { type: 'separator' },
        { role: 'about', label: '关于 DeepSeek Harness Desktop' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Initialize storage, seed, runtime, window, updater, and crash handling. */
async function bootstrap(): Promise<void> {
  await app.whenReady()
  const logDirectory = join(app.getPath('userData'), 'logs')
  await mkdir(logDirectory, { recursive: true, mode: 0o700 })
  runtimeLog = createWriteStream(join(logDirectory, 'runtime.log'), { flags: 'a', mode: 0o600 })

  const homes = await prepareHarnessHome()
  runtimeStore = new RuntimeStore(localDataRoot(), RUNTIME_MANIFEST_PUBLIC_KEY_PEM)
  await runtimeStore.prepare()
  runtimeState = await ensureSeedRuntime(runtimeStore, await runtimeStore.readState())
  const started = await startSelectedRuntime(runtimeStore, runtimeState, homes.harnessHome, homes.agentsHome)
  runningRuntime = started.runtime
  runtimeState = started.state
  mainWindow = await createMainWindow(runningRuntime.url)
  runtimeUpdater = new RuntimeUpdater(
    new GitHubRuntimeProvider(RUNTIME_RELEASE_REPOSITORY, RUNTIME_RELEASE_TAG_PREFIX, RUNTIME_MANIFEST_PUBLIC_KEY_PEM),
    runtimeStore,
    app.getVersion(),
    DESKTOP_PROTOCOL_VERSION,
  )
  installMenu()
  installTray(mainWindow)

  if (smokeTest) {
    mainWindow.close()
    if (mainWindow.isDestroyed() || desktopTray === null || desktopTray.isDestroyed()) {
      throw new Error('desktop tray did not retain the main window during smoke test')
    }
    quitting = true
    await quiesceDesktop()
    destroyTray()
    app.exit(0)
    return
  }

  void settlePendingRuntime(started.selectedId, runningRuntime).catch((error: unknown) => {
    writeRuntimeOutput('stderr', `pending runtime settlement failed: ${String(error)}\n`)
  })
  void runningRuntime.done
    .then(async (exit) => {
      if (quitting) return
      const options = { type: 'error' as const, message: 'Harness 运行时已退出', detail: JSON.stringify(exit) }
      if (mainWindow === null) await dialog.showMessageBox(options)
      else {
        showMainWindow()
        await dialog.showMessageBox(mainWindow, options)
      }
      await relaunchDesktop()
    })
    .catch((error: unknown) => {
      writeRuntimeOutput('stderr', `runtime exit handling failed: ${String(error)}\n`)
    })
  if (process.env.DSH_DESKTOP_DISABLE_UPDATE_CHECK !== '1') {
    void delay(2_000).then(() => checkForUpdates(false))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void (async () => {
      try {
        await quiesceDesktop()
      } catch (error) {
        quitting = false
        await dialog.showMessageBox({
          type: 'error',
          message: '无法安全退出 DeepSeek Harness Desktop',
          detail: String(error),
        })
        return
      }
      destroyTray()
      app.exit(0)
    })()
  })
  void bootstrap().catch(async (error: unknown) => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    if (smokeDataRoot === undefined) {
      await app.whenReady()
      await dialog.showMessageBox({
        type: 'error',
        title: 'DeepSeek Harness Desktop 启动失败',
        message: '无法启动 DeepSeek Harness Desktop',
        detail,
      })
    } else {
      try {
        await mkdir(resolve(smokeDataRoot), { recursive: true, mode: 0o700 })
        await writeFile(join(resolve(smokeDataRoot), 'smoke-error.txt'), `${detail}\n`, { mode: 0o600 })
      } catch (writeError) {
        process.stderr.write(`desktop smoke-test error report failed: ${String(writeError)}\n`)
      }
    }
    quitting = true
    try {
      await quiesceDesktop()
    } catch (cleanupError) {
      process.stderr.write(`desktop startup cleanup failed: ${String(cleanupError)}\n`)
    }
    destroyTray()
    app.exit(1)
  })
}
