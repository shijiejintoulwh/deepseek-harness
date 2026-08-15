# Windows desktop runtime implementation report

English | [中文](032217-windows-desktop-runtime-implementation-report.zh.md)

Completed: 2026-08-15 03:22:17 +08:00

## Result

The personal Windows MVP is implemented and packaged locally: a stable Electron shell from `dev-windesktop` hosts a separately versioned Harness runtime built from reviewed `master`, installs per user into a user-selected shell directory, checks for signed Harness updates in the application, asks before download and restart, retains the previous runtime, and rolls back a failed candidate without rolling back user data.

The final NSIS installer was installed into an isolated custom directory, the installed executable completed an offline first launch against its embedded runtime, and the product uninstaller removed that test installation; all three processes exited with code 0. Shell `1.0.2` fixes first-run import of npm/pnpm Junction-based dependency trees and uses the branded DeepSeek Harness icon.

No commit, push, GitHub Release, or repository secret was created.

## Delivered design

[`apps/desktop`](../../apps/desktop/README.md) owns only the Electron window, native update prompts, version selection, runtime storage, process lifecycle, first-run import, and rollback; it loads the ordinary `dsh web` UI over a validated loopback origin with renderer sandboxing, context isolation, and Node integration disabled.

The shell is a private `1.0.2` workspace application excluded from the npm dsh release family, while the publishable CLI and Web apps remain on the root Harness version.

The repository's blue DeepSeek Harness favicon supplies a seven-size Windows ICO used by the installer, uninstaller, executable, shortcuts, and Electron windows.

[`windows-runtime-release.yml`](../../.github/workflows/windows-runtime-release.yml) builds only from `master`, deploys a complete symlink-free hoisted production closure with Node 24, proves the staged Web shell, signs a strict manifest with Ed25519, and can publish immutable `runtime-v<harnessVersion>-r<revision>` assets.

[`windows-desktop-release.yml`](../../.github/workflows/windows-desktop-release.yml) checks out `dev-windesktop`, downloads a named signed runtime release as the offline seed, builds the assisted NSIS installer, runs a packaged smoke test, and can publish a manual `desktop-v*` shell release.

The runtime state keeps `active`, `previous`, `pending`, pending launch failures, and the skipped release in an atomic JSON document; a new candidate is committed only after the page loads and remains live for 30 seconds, while two failed launches reject it and preserve the active version.

The architecture and security rationale is retained in the active implemented [versioned Windows desktop runtime Agent Note](../../.agents/notes/implemented/architecture/2026-08-15-versioned-windows-desktop-runtime.md).

## Storage and installation

The NSIS configuration is assisted rather than one-click, sets `perMachine: false`, disables elevation, and enables `allowToChangeInstallationDirectory`.

The selected directory contains the Electron shell only; Electron user data and the desktop-specific `DSH_HOME` live below `%APPDATA%\DeepSeekHarnessDesktop`, while versioned runtimes and the selection document live below `%LOCALAPPDATA%\DeepSeekHarnessDesktop`.

First launch offers to copy an existing CLI Harness home after explicit consent and never modifies the source home. The importer omits rebuildable `node_modules` trees instead of following their package-manager Junctions, rejects links everywhere else, and allows a safe retry when an interrupted first run left an empty desktop home.

The failed `1.0.0` import was followed by newly generated desktop profiles, credentials, settings, and storage data. Shell `1.0.2` can replace an absent or empty real directory directly; for this now non-empty state it offers to preserve the complete directory as a sibling backup before importing, restores it if import fails, and never merges or silently overwrites the two homes.

## Local artifacts

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `dist-desktop/DeepSeek-Harness-Desktop-1.0.2-win-x64.exe` | 200,279,729 | `be6d2f04d0bc1e703b7b6dd0be9fda0f099e6c080eb1c366f3acb4c7c3a7a10b` |
| `dist-desktop/runtime/deepseek-harness-runtime-win32-x64-0.1.0-rc.5-r1.zip` | 113,588,985 | `b37780a7355786c35889d6805290e12b34d72ff94c8b0aba25d78dd4fc559864` |
| `dist-desktop/runtime/runtime-manifest.json` | 487 | `b09a917e6f12cc5a7bec6687fa8151679c9c634cd68cd9873268c66323b46aca` |
| `dist-desktop/runtime/runtime-manifest.sig` | 89 | `5f861dca9197c72d23a0282d4acb2b9743cebfb48c368d7fa508d594225f6e92` |

The signed manifest selects Harness `0.1.0-rc.5-r1`, commit `47f943859bef60e4160492346772ded9b24f765a`, Node `v24.19.0`, minimum desktop `1.0.0`, and desktop protocol `1`.

Generated installers, runtime assets, seeds, and local signing keys are ignored by Git; only source, workflows, documentation, and lockfile changes belong in version control.

## Verification evidence

| Evidence | Result |
|---|---|
| Runtime build | Production deploy, supply-chain lockfile policy, link containment, staged `dsh web` health check, ZIP, SHA-256, and Ed25519 manifest generation passed. |
| RuntimeStore installation | Final 113,588,985-byte release verified and installed as `0.1.0-rc.5-r1` in 115.3 seconds. |
| Installed runtime launch | Installed runtime announced a `127.0.0.1` URL, served the real Web shell, and reached process/log quiescence. |
| Packaged shell smoke | `win-unpacked` performed offline seed installation, selected the expected runtime, launched `dsh web`, and exited 0 in 123 seconds. |
| Packaged icon | The ICO contains seven Windows sizes from 16 through 256 pixels; the packaged resource matches its source hash exactly, icons extracted from both the application and NSIS installer show the blue DeepSeek Harness mark, and the branded `1.0.2` application exits its isolated startup smoke with code 0. |
| Junction import regression | The packaged `1.0.2` shell preserves an isolated non-empty desktop home as a sibling backup, imports the legacy marker, does not follow or change the external SDK Junction, rebuilds dependencies from the selected runtime, and launches `dsh web`. Seven focused import scenarios also pass, including failure restoration of a non-empty desktop home. |
| NSIS custom-directory test | Installer exit 0, installed-app smoke exit 0, uninstaller exit 0, and the isolated installation directory was removed. |
| Focused behavior tests | 7 files and 42 tests passed for desktop state, signature/archive installation, home import, process lifecycle, runtime manifest, release-family exclusion, and pnpm-style profile traversal. |
| Workflow and change-scope tests | 2 files passed; 17 tests passed and 3 platform-inapplicable tests were skipped. |
| Final combined regression | 9 related files passed; 59 tests passed and 3 platform-inapplicable tests were skipped. |
| Repository build | Complete host, client, and Web build passed in 93.8 seconds. |
| Static checks | Client TypeScript check, full-repository lint, knip, publint, workspace constraints, package licenses, package invariants, built invariants, NodeNext declarations, and runtime closure passed. |
| Documentation checks | All 28 doc-sync gates passed, including Markdown links and wrapping, Agent Note format and classification, bilingual pairing, catalogs, documentation budgets, and the documentation site build. |
| Agent Note audit | The new architecture note remains active; no implemented note was archived, no rejected note was kept or deleted, and no proposed note was rejected. The npm release note was factually updated to exclude the private desktop application. |

## Publication handoff

The local signing pair exists only in ignored `.desktop-local/runtime-signing`; the private PEM must be copied into the protected `runtime-release` GitHub environment as `RUNTIME_SIGNING_PRIVATE_KEY_PEM` without committing or logging it.

The runtime builder, production-closure fixes, CLI peer declarations, and runtime workflow must land on `master`; the Electron application and desktop workflow remain on `dev-windesktop`, which then consumes the published runtime tag.

The current environment could not refresh the SSH remote because GitHub rejected the available public key, so remote CI and Releases remain unverified and unpublished.

After branch changes are reviewed and pushed, dispatch the runtime workflow from `master` with revision `1`, minimum desktop `1.0.0`, and publication enabled; then dispatch the desktop workflow on `dev-windesktop` with that runtime tag and `desktop-v1.0.2`.

## Known limits

The personal MVP has no Authenticode certificate, so Windows can show an unknown-publisher warning even though the Harness runtime has an independent Ed25519 signature and SHA-256 digest.

Updates are complete self-contained archives rather than deltas, and the Electron shell does not update automatically; a shell compatibility or security change requires a manually installed `desktop-v*` release.

Update discovery uses the public GitHub API and can be affected by anonymous rate limits or network availability, while first launch and the already installed runtime remain offline-capable.
