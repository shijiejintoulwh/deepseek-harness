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
import { prerelease } from 'semver'
import {
  app,
  BrowserWindow,
  clipboard,
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
  DESKTOP_RELEASE_REPOSITORY,
  DESKTOP_RELEASE_TAG_PREFIX,
  DESKTOP_UPDATE_PUBLIC_KEY_PEM,
  MAX_PENDING_LAUNCH_FAILURES,
  PENDING_RUNTIME_STABILITY_MS,
  RUNTIME_MANIFEST_PUBLIC_KEY_PEM,
  RUNTIME_RELEASE_REPOSITORY,
  RUNTIME_RELEASE_TAG_PREFIX,
  RUNTIME_START_TIMEOUT_MS,
} from './config.ts'
import { GitHubDesktopReleaseSource } from './desktop-release-source.ts'
import {
  readInstalledShellManifestSha256,
  writeInstalledShellIdentity,
} from './desktop-update-state.ts'
import { ElectronUpdaterAdapter } from './electron-updater-adapter.ts'
import { EXTERNAL_LINK_CHANNEL, externalHttpUrl } from './external-navigation.ts'
import { GitHubRuntimeProvider } from './github-provider.ts'
import {
  canBackupHarnessHome,
  canImportHarnessHome,
  importHarnessHomeWithBackup,
  legacyHarnessHome,
  pathExists,
} from './home-import.ts'
import { UpdateProgressWindow, type UpdateProgressPresentation } from './progress-window.ts'
import { launchRuntime, type RunningRuntime } from './runtime-process.ts'
import {
  commitPendingRuntime,
  recordPendingFailure,
  rollbackRuntime,
  runtimeId,
  selectedRuntimeId,
  type RuntimeManifest,
  type RuntimeState,
} from './runtime-model.ts'
import { RuntimeStore } from './runtime-store.ts'
import {
  ShellUpdater,
  type AvailableShellUpdate,
  type ShellUpdateChannel,
  type ShellUpdateState,
} from './shell-updater.ts'
import { parseShellThemeReport, shellBackgroundColor, SHELL_THEME_CHANNEL } from './shell-theme.ts'
import { installCloseToTray, showTrayWindow } from './tray-lifecycle.ts'
import { describeUpdateFailure } from './update-error.ts'
import { RuntimeUpdater, type RuntimeUpdateCheck, type RuntimeUpdateProgress } from './updater.ts'
import {
  createDesktopVersionInfo,
  type DesktopVersionInfo,
  formatVersionClipboardText,
  formatVersionDialogDetail,
} from './version-info.ts'

const PRODUCT_DIRECTORY = 'DeepSeekHarnessDesktop'
const HOME_IMPORT_DECISION = 'home-import-decision-v1.json'
const INSTALLED_SHELL_IDENTITY = 'installed-shell-v1.json'
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
let shellUpdater: ShellUpdater | null = null
let runtimeState: RuntimeState | null = null
let runtimeLog: WriteStream | null = null
let desktopTray: Tray | null = null
let removeCloseToTray: (() => void) | null = null
let removeSessionEndListener: (() => void) | null = null
let sessionEndReset: ReturnType<typeof setTimeout> | null = null
let sessionEnding = false
let quitting = false
let updateInProgress = false
let runtimeRequestedBrowserOpen = false

/** Return a Windows local-data root without making the install directory writable. */
function localDataRoot(): string {
  if (smokeDataRoot !== undefined) return join(resolve(smokeDataRoot), 'runtime-data')
  const local = process.env.LOCALAPPDATA
  return resolve(local === undefined || local === '' ? app.getPath('userData') : local, PRODUCT_DIRECTORY)
}

/** Private desktop state file that binds an installed version to signed bytes. */
function installedShellIdentityPath(): string {
  return join(app.getPath('userData'), 'shell-update', INSTALLED_SHELL_IDENTITY)
}

/** Private directory for blockmaps retained until explicit installation. */
function shellUpdateDownloadDirectory(): string {
  return join(app.getPath('userData'), 'shell-update', 'downloads')
}

/** Select the desktop release channel from the packaged semantic version. */
function installedShellChannel(version: string): ShellUpdateChannel {
  return prerelease(version) === null ? 'stable' : 'preview'
}

/** Write runtime output to the private desktop log. */
function writeRuntimeOutput(stream: 'stdout' | 'stderr', text: string): void {
  if (text.includes('dsh web: opening the default browser')) runtimeRequestedBrowserOpen = true
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
  removeSessionEndListener?.()
  removeSessionEndListener = null
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
      { label: '检查桌面端更新', click: () => { show(); void checkForShellUpdates(true) } },
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
  const onSessionEnd = (): void => {
    sessionEnding = true
    if (sessionEndReset !== null) clearTimeout(sessionEndReset)
    sessionEndReset = setTimeout(() => {
      sessionEndReset = null
      sessionEnding = false
    }, SESSION_END_CLOSE_WINDOW_MS)
  }
  window.on('query-session-end', onSessionEnd)
  removeSessionEndListener = () => {
    window.removeListener('query-session-end', onSessionEnd)
  }
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

/** Rejection recorded when a pending candidate is dropped after repeated launch failures. */
interface RuntimeRejection {
  /** Candidate id that failed to launch. */
  readonly candidate: string
  /** Runtime id the host fell back to, or null when none remains. */
  readonly fallback: string | null
  /** First launch failure description. */
  readonly reason: string
}

/** Launch the selected candidate, retry it once, then fall back to active. */
async function startSelectedRuntime(
  store: RuntimeStore,
  initialState: RuntimeState,
  harnessHome: string,
  agentsHome: string,
): Promise<{
  runtime: RunningRuntime
  manifest: RuntimeManifest
  state: RuntimeState
  selectedId: string
  rejection: RuntimeRejection | null
}> {
  let state = initialState
  let rejection: RuntimeRejection | null = null
  for (;;) {
    const selected = selectedRuntimeId(state)
    if (selected === null) throw new Error('no Harness runtime is selected')
    try {
      const manifest = await store.readInstalledManifest(selected)
      const runtime = await launchRuntime({
        runtimeDirectory: store.runtimeDirectory(selected),
        harnessHome,
        agentsHome,
        timeoutMs: RUNTIME_START_TIMEOUT_MS,
        onOutput: writeRuntimeOutput,
      })
      return { runtime, manifest, state, selectedId: selected, rejection }
    } catch (error) {
      if (state.pending === null) throw error
      const reason = error instanceof Error ? error.message : String(error)
      writeRuntimeOutput('stderr', `pending Harness runtime ${selected} failed to start: ${reason}\n`)
      state = recordPendingFailure(state, MAX_PENDING_LAUNCH_FAILURES)
      await store.writeState(state)
      if (state.pending === null) {
        writeRuntimeOutput(
          'stderr',
          `pending Harness runtime ${selected} rejected after repeated launch failures; continuing with ${state.active ?? 'no active runtime'}\n`,
        )
        rejection = { candidate: selected, fallback: state.active, reason }
      }
    }
  }
}

/** Keep automatic navigation inside the loopback Harness origin. */
function applyNavigationPolicy(window: BrowserWindow, runtimeUrl: string): void {
  const runtimeOrigin = new URL(runtimeUrl).origin
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    try {
      const candidate = new URL(url)
      if (candidate.origin === runtimeOrigin) return
      event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
  const onExternalLink = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender !== window.webContents || typeof value !== 'string') return
    const candidate = externalHttpUrl(value, runtimeUrl)
    if (candidate === null) return
    void shell.openExternal(candidate).catch((error: unknown) => {
      writeRuntimeOutput('stderr', `external link failed: ${String(error)}\n`)
    })
  }
  ipcMain.on(EXTERNAL_LINK_CHANNEL, onExternalLink)
  window.once('closed', () => {
    ipcMain.removeListener(EXTERNAL_LINK_CHANNEL, onExternalLink)
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

/** Convert runtime-update state into target-neutral progress-window text. */
function presentRuntimeUpdate(progress: RuntimeUpdateProgress): UpdateProgressPresentation {
  if (progress.phase === 'downloading') {
    const fraction = progress.progress.received / progress.progress.total
    return {
      phase: 'progress',
      status: '正在下载 Harness 运行时',
      detail: `${Math.floor(fraction * 100)}%`,
      fraction,
    }
  }
  if (progress.phase === 'verifying') {
    return {
      phase: 'indeterminate',
      status: '正在验证签名并安装',
      detail: '当前版本仍可继续回滚',
    }
  }
  return {
    phase: 'complete',
    status: '更新已准备完成',
    detail: progress.runtimeId,
  }
}

/** Convert shell-update state into target-neutral progress-window text. */
function presentShellUpdate(state: ShellUpdateState): UpdateProgressPresentation | null {
  if (state.kind === 'downloading') {
    if (state.progress.total === null) {
      return {
        phase: 'indeterminate',
        status: '正在下载桌面端更新',
        detail: `${state.progress.received} 字节`,
      }
    }
    const fraction = state.progress.received / state.progress.total
    return {
      phase: 'progress',
      status: '正在下载桌面端更新',
      detail: `${Math.floor(fraction * 100)}%`,
      fraction,
    }
  }
  if (state.kind === 'verified') {
    return {
      phase: 'indeterminate',
      status: '正在准备桌面端更新',
      detail: '安装包和 blockmap 已通过签名清单校验',
    }
  }
  if (state.kind === 'ready') {
    return {
      phase: 'complete',
      status: '桌面端更新已准备完成',
      detail: state.release.manifest.version,
    }
  }
  return null
}

/** Report a shell update failure after a manual action or accepted download. */
async function showShellUpdateFailure(state: Extract<ShellUpdateState, { kind: 'error' }>): Promise<void> {
  const detail = `${state.code}: ${state.message}`
  writeRuntimeOutput('stderr', `desktop shell update failed: ${detail}\n`)
  if (mainWindow !== null) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      message: '桌面端更新失败',
      detail,
    })
  }
}

/** Quiesce the application and hand one reverified release to NSIS. */
async function installShellUpdate(release: AvailableShellUpdate): Promise<void> {
  const updater = shellUpdater
  const window = mainWindow
  if (updater === null || window === null) return
  await writeInstalledShellIdentity(installedShellIdentityPath(), release)
  quitting = true
  try {
    await quiesceDesktop()
  } catch (error) {
    quitting = false
    await dialog.showMessageBox(window, {
      type: 'error',
      message: '无法安全安装桌面端更新',
      detail: String(error),
    })
    return
  }
  destroyTray()
  const result = await updater.install(new AbortController().signal)
  if (result.kind === 'installing') return
  const detail = result.kind === 'error' ? `${result.code}: ${result.message}` : `unexpected state: ${result.kind}`
  await dialog.showMessageBox(window, {
    type: 'error',
    message: '无法启动桌面端安装程序',
    detail: `${detail}\n当前版本将重新启动。`,
  })
  app.relaunch()
  app.exit(1)
}

/** Offer restart only after both signed desktop assets are ready. */
async function offerShellUpdateInstall(release: AvailableShellUpdate): Promise<void> {
  const window = mainWindow
  if (window === null) return
  const answer = await dialog.showMessageBox(window, {
    type: 'info',
    title: '桌面端更新已准备完成',
    message: `DeepSeek Harness Desktop ${release.manifest.version} 已准备完成`,
    detail: '重启会先安全停止 Harness 运行时，再启动 NSIS 安装程序。桌面端更新不提供自动回滚。',
    buttons: ['重启并更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer.response === 0) await installShellUpdate(release)
}

/** Download one consented shell release and expose explicit install consent. */
async function downloadShellUpdate(): Promise<void> {
  const updater = shellUpdater
  const window = mainWindow
  if (updater === null || window === null) return
  const controller = new AbortController()
  const progress = new UpdateProgressWindow(
    app.getAppPath(),
    window,
    () => { controller.abort() },
    '更新 DeepSeek Harness Desktop',
  )
  const dispose = updater.onStateChange((state) => {
    const presentation = presentShellUpdate(state)
    if (presentation !== null) progress.setProgress(presentation)
  })
  try {
    const result = await updater.download(controller.signal)
    progress.close()
    if (result.kind === 'ready') await offerShellUpdateInstall(result.release)
    else if (result.kind === 'error') await showShellUpdateFailure(result)
  } finally {
    dispose()
    progress.close()
  }
}

/** Present a verified shell candidate before any installer bytes are downloaded. */
async function offerShellUpdate(release: AvailableShellUpdate): Promise<void> {
  const window = mainWindow
  if (window === null) return
  const answer = await dialog.showMessageBox(window, {
    type: 'question',
    title: '桌面端更新可用',
    message: `发现 DeepSeek Harness Desktop ${release.manifest.version}`,
    detail: '下载完成后仍会再次征求重启安装确认；Harness 运行时和用户数据不会被替换。',
    buttons: ['立即下载', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer.response === 0) await downloadShellUpdate()
}

/** Interpret one authenticated shell check without acquiring the shared update lock. */
async function handleShellUpdateCheck(state: ShellUpdateState, manual: boolean): Promise<void> {
  if (state.kind === 'available') {
    await offerShellUpdate(state.release)
    return
  }
  if (state.kind === 'error') {
    if (manual) await showShellUpdateFailure(state)
    else writeRuntimeOutput('stderr', `desktop shell update check failed: ${state.code}: ${state.message}\n`)
    return
  }
  if (state.kind === 'incompatible') {
    if (manual && mainWindow !== null) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: '最新桌面端版本不适用于当前安装',
        detail: `不兼容项：${state.reason}`,
      })
    }
    return
  }
  if (state.kind === 'none' && manual && mainWindow !== null) {
    await dialog.showMessageBox(mainWindow, { type: 'info', message: '当前桌面端已是最新版本' })
  }
}

/** Check shell releases while the caller owns the shared update lock. */
async function runShellUpdateCheck(manual: boolean): Promise<void> {
  const updater = shellUpdater
  if (updater === null) return
  const retained = updater.state
  if (retained.kind === 'ready') {
    await offerShellUpdateInstall(retained.release)
    return
  }
  if (retained.kind === 'error'
    && retained.operation === 'install'
    && retained.release !== undefined
    && retained.downloaded !== undefined) {
    await offerShellUpdateInstall(retained.release)
    return
  }
  const state = await updater.check(new AbortController().signal)
  await handleShellUpdateCheck(state, manual)
}

/** Check the desktop release feed once; shell and runtime transfers never overlap. */
async function checkForShellUpdates(manual: boolean): Promise<void> {
  if (updateInProgress || shellUpdater === null) return
  updateInProgress = true
  try {
    await runShellUpdateCheck(manual)
  } finally {
    updateInProgress = false
  }
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
      buttons: ['检查桌面端更新', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if (answer.response === 0) await runShellUpdateCheck(true)
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

  const controller = new AbortController()
  const progress = new UpdateProgressWindow(app.getAppPath(), window, () => {
    controller.abort()
  })
  try {
    runtimeState = await updater.install(release, await store.readState(), (value) => {
      progress.setProgress(presentRuntimeUpdate(value))
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

/** Show versions for the running Harness process and its Electron host. */
async function showVersionInfo(window: BrowserWindow, info: DesktopVersionInfo): Promise<void> {
  const answer = await dialog.showMessageBox(window, {
    type: 'info',
    title: '关于 DeepSeek Harness',
    message: 'DeepSeek Harness',
    detail: formatVersionDialogDetail(info),
    buttons: ['复制版本信息', '关闭'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (answer.response === 0) clipboard.writeText(formatVersionClipboardText(info))
}

/** Install the application menu after runtime services are ready. */
function installMenu(window: BrowserWindow, versionInfo: DesktopVersionInfo): void {
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
        {
          id: 'check-shell-updates',
          label: '检查桌面端更新',
          click: () => void checkForShellUpdates(true),
        },
        { type: 'separator' },
        {
          id: 'about-harness',
          label: '关于 DeepSeek Harness',
          click: () => void showVersionInfo(window, versionInfo),
        },
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
  const desktopVersion = app.getVersion()
  const desktopChannel = installedShellChannel(desktopVersion)
  const installedManifestSha256 = await readInstalledShellManifestSha256(
    installedShellIdentityPath(),
    desktopVersion,
  )
  const versionInfo = createDesktopVersionInfo(started.manifest, desktopVersion)
  mainWindow = await createMainWindow(runningRuntime.url)
  runtimeUpdater = new RuntimeUpdater(
    new GitHubRuntimeProvider(RUNTIME_RELEASE_REPOSITORY, RUNTIME_RELEASE_TAG_PREFIX, RUNTIME_MANIFEST_PUBLIC_KEY_PEM),
    runtimeStore,
    desktopVersion,
    DESKTOP_PROTOCOL_VERSION,
  )
  shellUpdater = new ShellUpdater(
    new ElectronUpdaterAdapter(
      new GitHubDesktopReleaseSource(DESKTOP_RELEASE_REPOSITORY, DESKTOP_RELEASE_TAG_PREFIX),
      desktopChannel,
      shellUpdateDownloadDirectory(),
      (message) => { writeRuntimeOutput('stderr', `desktop updater: ${message}\n`) },
    ),
    {
      version: desktopVersion,
      channel: desktopChannel,
      platform: process.platform,
      arch: process.arch,
      ...(installedManifestSha256 === undefined ? {} : { manifestSha256: installedManifestSha256 }),
    },
    DESKTOP_UPDATE_PUBLIC_KEY_PEM,
  )
  installMenu(mainWindow, versionInfo)
  installTray(mainWindow)

  if (started.rejection !== null && !smokeTest) {
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: 'Harness 更新未能激活',
      detail: `新版本 ${started.rejection.candidate} 连续启动失败，已回退到 ${started.rejection.fallback ?? '无可用版本'}。\n`
        + `原因：${started.rejection.reason}\n`
        + '详情见用户数据目录 logs\\runtime.log。',
      buttons: ['确定'],
      noLink: true,
    })
  }

  if (smokeTest) {
    if (Menu.getApplicationMenu()?.getMenuItemById('about-harness')?.label !== '关于 DeepSeek Harness') {
      throw new Error('desktop application menu does not expose Harness version information')
    }
    if (Menu.getApplicationMenu()?.getMenuItemById('check-shell-updates')?.label !== '检查桌面端更新') {
      throw new Error('desktop application menu does not expose shell update discovery')
    }
    const automaticPopupDenied: unknown = await mainWindow.webContents.executeJavaScript(
      "window.open('https://example.invalid/dsh-desktop-smoke') === null",
    )
    if (automaticPopupDenied !== true) {
      throw new Error('desktop navigation policy did not deny an automatic external popup')
    }
    if (runtimeRequestedBrowserOpen) {
      throw new Error('desktop runtime requested the default browser during startup')
    }
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
    void delay(2_000).then(async () => {
      await checkForShellUpdates(false)
      await checkForUpdates(false)
    })
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
