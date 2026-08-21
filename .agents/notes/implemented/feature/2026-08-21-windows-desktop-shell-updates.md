# Agent Note: In-app Windows desktop shell updates

Status: implemented

English | [中文](2026-08-21-windows-desktop-shell-updates.zh.md)

## Problem

The independently versioned Electron shell needs to receive fixes without asking a user to find and run each `desktop-v*` installer manually. The existing Harness updater cannot own this operation: it installs immutable runtime directories, maintains `active`/`previous`/`pending` state, and can roll back by selecting another runtime, while NSIS replaces files in the shell installation directory and restarts the application.

GitHub channel metadata and transport security do not authenticate a community desktop installer by themselves. Preview and stable users also need different discovery rules so an experimental release neither displaces the stable channel nor downgrades an installed shell.

## Decision

The Electron main process owns a `ShellUpdater` that is independent of the Harness runtime updater and `RuntimeStore`. Shell checks, downloads, errors, and installation readiness use their own state; shell and runtime downloads are mutually exclusive, and shell installation never changes runtime selection or deletes a runtime version.

The installed shell version selects its channel. A stable build accepts only a higher stable version. A preview build may accept a higher preview or stable version. Exact SemVer comparison rejects the installed version, older releases, cross-channel stable-to-preview movement, and every automatic downgrade.

The host performs a quiet background check and exposes a separate `检查桌面端更新` command beside the Harness update command. Discovery never downloads by itself: the user confirms the transfer, and a verified download produces a separate `重启并更新` confirmation. Ordinary application exit does not install a pending shell release.

`electron-updater` supplies the Windows `NsisUpdater`, channel metadata handling, blockmap support, and NSIS handoff. Automatic download and install-on-quit are disabled. When the user confirms installation, the host first quiesces the Harness process tree and log stream through the existing explicit-exit path, releases its tray resources, and then asks the updater to restart into the assisted per-user NSIS installer. The installer retains the selected installation directory.

Every desktop release set contains the NSIS executable, its blockmap, exactly one channel file (`latest.yml` for stable or `preview.yml` for preview), `desktop-update-manifest.json`, and `desktop-update-manifest.sig`. A desktop-specific Ed25519 key signs the exact manifest bytes. The strict manifest binds the shell version, stable or preview channel, source commit, installer and blockmap names, sizes, SHA-256 digests, and publication time. The client verifies the signature before using manifest fields, requires the selected channel to agree with the candidate version, and verifies both downloaded files before exposing the restart action.

The `desktop-v*` tag workflow checks the package version, tag, channel metadata, complete unsigned asset set, installer size, and SHA-256 in a clean Windows build and packaged smoke without receiving a release credential. The release operator then supplies the expected version, tag, channel, and source commit to a local signer, which validates the exact four-file set before reading the local private key and adding the detached signature. The operator publishes those five files explicitly after the tag workflow succeeds. A preview release writes only preview channel metadata; a stable release writes only stable channel metadata. A tag and version identify immutable bytes and are never republished with another digest.

Shell installation replaces only Electron application files. User data and the desktop-specific Harness home remain under `%APPDATA%\DeepSeekHarnessDesktop`; runtime versions and their atomic selection state remain under `%LOCALAPPDATA%\DeepSeekHarnessDesktop`. Download, verification, discovery, or installer failure therefore leaves the current shell and runtime state available.

The MVP does not add automatic shell rollback. A failed download or verification remains in the running shell and can be retried. An installer failure retains the verified package for an explicit retry or manual installation; it does not attempt to restore application files while NSIS may still own them.

## Verification

Focused updater tests pin stable and preview selection, no downgrade, user-confirmed download, user-confirmed restart, install-on-quit suppression, manifest signature and strict-field rejection, size and SHA-256 mismatch, concurrent-update exclusion, and failure behavior. Local signer tests pin exact release inputs, complete desktop assets, and signature verification. Workflow tests pin version/tag/channel alignment, repository-read-only permissions, absence of release credentials and publication commands, and preview metadata isolation. The packaged smoke covers the current installer and update metadata. A real installed preview-to-preview transition remains a named coverage gap until a higher preview exists; that release is not accepted as upgrade-ready until the transition preserves a custom installation directory and both application-data roots and proves the new shell starts.

## Alternatives considered

**Reuse the Harness runtime updater and rollback state.** Rejected because runtime activation selects immutable directories, while a shell update replaces the running Electron installation through NSIS. Sharing state would make an installer failure capable of corrupting an unrelated runtime rollback record.

**Trust Electron channel metadata and HTTPS without a desktop manifest signature.** Rejected because channel YAML locates files but does not provide the product's immutable release identity. The signed manifest makes the expected channel, version, source, byte length, and digest independently verifiable.

**Download every discovered release automatically.** Rejected because a background check must not consume installer bandwidth without consent. Discovery, download, and restart remain separate user decisions.

**Install automatically on ordinary exit.** Rejected because a tray application may exit during active work or operating-system shutdown. Only the explicit restart action authorizes the quiescent shutdown and NSIS handoff.

**Give stable users preview releases.** Rejected because prerelease testing must not silently widen the stable channel. Preview users may still move to a newer stable release without reinstalling or downgrading.

**Implement shell rollback inside the MVP.** Rejected because NSIS mutates application files outside the runtime's immutable-directory model. A trustworthy rollback needs a separately packaged previous installer and recovery process; download and verification failures can safely keep the running shell without that mechanism.

## Consequences

Desktop fixes reach installed preview and stable users without coupling shell releases to the faster Harness runtime cadence. Users retain control over installer bandwidth and restart timing, and the existing runtime activation, candidate validation, and rollback behavior remain unchanged.

Desktop release publication gains a second signing identity and immutable manifest. The private key stays outside the repository and GitHub on the local release machine; rotating it requires a shell release that embeds the replacement public key. Release publication is therefore an explicit local operation rather than an unattended GitHub Actions step.

NSIS blockmaps may reduce transfer size, but correctness still depends on the fully downloaded installer's signed expected digest. The lack of automatic shell rollback means an installer failure may require an explicit retry or manual reinstall, while `%APPDATA%` user data and `%LOCALAPPDATA%` runtime state remain recoverable and independent.
