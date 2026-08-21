/**
 * Native version presentation for the independently released Harness runtime
 * and Electron host.
 */

import type { RuntimeManifest } from './runtime-model.ts'

/** Version fields for the exact Harness runtime process selected at startup. */
export interface DesktopVersionInfo {
  /** Harness semantic version from the installed runtime manifest. */
  readonly harnessVersion: string
  /** Packaging revision for this Harness version. */
  readonly runtimeRevision: number
  /** Electron host version from its packaged application manifest. */
  readonly desktopVersion: string
  /** Source commit bound by the installed runtime manifest. */
  readonly commitSha: string
  /** Bundled Node version bound by the installed runtime manifest. */
  readonly nodeVersion: string
}

/**
 * Build native version information from one installed runtime manifest.
 * @param manifest - Manifest for the runtime process selected at startup.
 * @param desktopVersion - Current Electron host version.
 * @returns Version fields used by the About dialog and copied diagnostics.
 */
export function createDesktopVersionInfo(
  manifest: RuntimeManifest,
  desktopVersion: string,
): DesktopVersionInfo {
  return {
    harnessVersion: manifest.harnessVersion,
    runtimeRevision: manifest.runtimeRevision,
    desktopVersion,
    commitSha: manifest.commitSha,
    nodeVersion: manifest.nodeVersion,
  }
}

/**
 * Format the concise fields shown in the native About dialog.
 * @param info - Current desktop and Harness versions.
 * @returns Multi-line dialog detail.
 */
export function formatVersionDialogDetail(info: DesktopVersionInfo): string {
  return [
    `Harness 版本：${info.harnessVersion}`,
    `运行时修订：r${info.runtimeRevision}`,
    `桌面端版本：${info.desktopVersion}`,
  ].join('\n')
}

/**
 * Format the complete version record copied for diagnostics.
 * @param info - Current desktop and Harness versions.
 * @returns Multi-line clipboard text.
 */
export function formatVersionClipboardText(info: DesktopVersionInfo): string {
  return [
    'DeepSeek Harness',
    `Harness 版本：${info.harnessVersion}`,
    `运行时修订：r${info.runtimeRevision}`,
    `桌面端版本：${info.desktopVersion}`,
    `运行时提交：${info.commitSha}`,
    `Node 版本：${info.nodeVersion}`,
  ].join('\n')
}
