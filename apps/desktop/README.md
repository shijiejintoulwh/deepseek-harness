# DeepSeek Harness Desktop

English | [中文](README.zh.md)

`dsh-desktop` is a private Windows Electron host for the ordinary Harness Web profile.

The host owns installation, runtime selection, process supervision, native prompts, and rollback; Harness features continue to come from an independently versioned `dsh web` runtime.

## Release ownership

Desktop source and installer releases live on `dev-windesktop` under `desktop-v*` tags, while verified Harness runtime releases are built from `master` under immutable `runtime-v<harnessVersion>-r<revision>` tags in `shijiejintoulwh/deepseek-harness`.

Preview shell versions use the same SemVer prerelease suffix in the desktop package and `desktop-v*` tag. Preview and stable releases publish separate Electron update channels, so a preview release cannot replace stable channel metadata or become the latest stable desktop release.

The desktop package is private and deliberately excluded from the npm dsh release family.

The [upstream sync workflow](../../.github/workflows/sync-upstream-runtime.yml) is defined on the fork's default branch and runs every six hours. Scheduled and manual runs merge-sync `deepseek-ai/deepseek-harness` only into fork `master` without rewriting it, while a `master` push packages that exact pushed commit. Packaging tools are pinned read-only from `dev-windesktop`; the workflow never checks out, merges, or pushes that desktop branch. The production dependency closure and signed source commit come only from `master`. A conflict or any build, smoke, signing, or publication failure stops the release; the next run detects a synchronized `master` commit with no release target and retries the unfinished publication.

Automatic operation requires both workflow files on the default branch, GitHub Actions workflow permissions set to read and write, and `RUNTIME_SIGNING_PRIVATE_KEY_PEM` in the `runtime-release` environment. Required reviewers on that environment intentionally turn signing back into a manual approval step.

The runtime workflow emits one self-contained Windows x64 ZIP, `runtime-manifest.json`, and an Ed25519 detached signature; the manifest binds the Harness version, packaging revision, source commit, Node version, archive size, SHA-256 digest, minimum desktop version, and desktop protocol version.

The desktop workflow builds and validates the NSIS installer, its blockmap, one channel file (`latest.yml` for stable or `preview.yml` for preview), and `desktop-update-manifest.json` without receiving a release credential. The local release machine validates that unsigned set against the intended version, `desktop-v*` tag, channel, and source commit before adding the Ed25519 detached signature and publishing exactly those five files. The signed desktop manifest binds the shell version, channel, source commit, installer and blockmap names, sizes, and SHA-256 digests.

The desktop installer bundles one verified release set as an offline seed, so first launch does not depend on GitHub availability.

## Storage and lifecycle

The assisted NSIS installer is per-user, does not request elevation, and lets the user choose the shell installation directory.

The installer, uninstaller, executable, shortcuts, and Electron windows use the multi-size blue DeepSeek Harness icon in `build/icon.ico`.

Electron user data, including the desktop-specific `DSH_HOME`, is stored under `%APPDATA%\DeepSeekHarnessDesktop`; versioned runtimes and the atomic selection document are stored under `%LOCALAPPDATA%\DeepSeekHarnessDesktop` and never under the selected installation directory.

The main window waits for its sandboxed CommonJS preload to report the Web application's resolved color scheme and whether the persisted preference follows the operating system. The host validates the sending window and fixed report fields before applying Electron's native theme and the matching BrowserWindow background, so the Windows title bar, application menu, dialogs, and Web content switch together without exposing an Electron API to the page.

Closing the main window hides it in the Windows notification area while the Harness runtime keeps running. Clicking the tray icon restores and focuses the window; its context menu opens the window, checks for Harness updates, or performs an explicit full exit. The first intercepted close displays a quiet notification explaining how to exit.

On first launch, the host offers to copy an existing CLI Harness home into the desktop-specific home without modifying the source. Rebuildable `node_modules` trees are omitted instead of following package-manager junctions, and every link outside those dependency trees is rejected. An empty home left by an interrupted import can be retried directly; if desktop data already exists, the host offers once to preserve it as a sibling backup before importing and automatically restores it if the replacement import fails.

The host starts the selected runtime with its bundled Node 24 executable and an explicit `--no-open`, accepts only the announced `http://127.0.0.1` origin, waits for the real Web shell health marker, and waits for the child process and log stream to settle before exit or relaunch. A runtime that predates browser launching also predates that option, so the host retries without it only after the runtime rejects the exact `--no-open` option.

Startup never opens the system browser. Automatic popups and cross-origin top-level navigation are denied; only a trusted user activation on an external HTTP(S) link is handed to the default browser, and the main process revalidates the sender and URL before opening it.

At startup the host checks the latest `runtime-v*` release, prompts before downloading, verifies the Ed25519 signature before parsing metadata, enforces compatibility, verifies size and SHA-256, rejects unsafe ZIP paths and links, and installs into a fresh version directory before staging it for restart. Discovery prefers the anonymous GitHub REST feed; when GitHub reports a rate limit, the host honors its reset time and uses the public Releases Atom feed with direct signed-asset URLs instead of repeating the blocked REST request. If both discovery paths are unavailable, a manual check reports an estimated retry interval while the automatic check remains silent.

The independent `ShellUpdater` checks the desktop channel selected by the installed shell version. Stable builds accept only a higher stable version; preview builds may accept a higher preview or stable version, and neither channel permits an automatic downgrade. A background check remains silent when no update is available, while `帮助` > `检查桌面端更新` reports the result of a manual check.

Finding a shell release does not start a download. The host asks before `electron-updater` downloads the NSIS release, verifies the desktop manifest signature and the downloaded installer and blockmap against their signed sizes and SHA-256 digests, then offers `重启并更新`. The install action stops the Harness process and log stream through the normal quiescent shutdown path before handing the verified package to NSIS; an ordinary application exit never installs a pending shell release implicitly.

Shell download and Harness runtime download are mutually exclusive. A shell update replaces only the Electron installation files: `%APPDATA%` user data, the desktop-specific Harness home, `%LOCALAPPDATA%` runtime versions, and runtime rollback state remain outside the installation directory and are not replaced.

Upstream synchronization and runtime release publication are unattended. Desktop shell publication requires a local signature and an explicit GitHub Release command; installation on a personal machine keeps the existing download and restart confirmations so a background check cannot consume bandwidth or interrupt active work without consent.

A candidate becomes active only after its page loads and remains alive for 30 seconds; failed candidate launches retain the current runtime, two failed attempts reject the candidate, and the menu can swap the current and previous versions for a manual rollback. A rejected candidate is recorded in the desktop log and reported once at the next startup instead of silently keeping the previous version.

## Version information

Open `帮助` > `关于 DeepSeek Harness` to view the Harness semantic version and packaging revision from the manifest of the exact runtime process selected at startup, alongside the Electron host version. The copy action adds the runtime source commit and bundled Node version for diagnostics. This local view does not perform update discovery or require network access.

## Local build

Generate the signing pair once into the ignored local directory, then embed the public key in [`src/config.ts`](src/config.ts) and protect the private PEM as the `RUNTIME_SIGNING_PRIVATE_KEY_PEM` secret in the `runtime-release` GitHub environment:

```powershell
pnpm exec tsx scripts/runtime-release/generate-signing-key.ts --out .desktop-local/runtime-signing
```

Generate the independent desktop-update signing pair into the ignored shell directory. Embed `desktop-update-public.pem` in [`src/config.ts`](src/config.ts) and retain `desktop-update-private.pem` only on the local release machine; do not upload it to GitHub Actions or a Release. The generator refuses to replace either key:

```powershell
pnpm exec tsx scripts/desktop-release/generate-signing-key.ts --out .desktop-local/shell-signing
```

From a built Windows x64 checkout using Node 24, create and verify the release set, copy it as the offline seed, and package the installer:

```powershell
pnpm exec tsx scripts/runtime-release/build-windows-runtime.ts --private-key .desktop-local/runtime-signing/runtime-signing-private.pem
pnpm exec tsx scripts/runtime-release/prepare-desktop-seed.ts --from dist-desktop/runtime
pnpm run desktop:dist
```

After assembling the four unsigned desktop files in `dist-desktop/release`, sign them with independently reviewed release inputs. The command validates the exact file set, manifest fields, channel metadata, source commit, sizes, and digests before it reads the local private key and creates `desktop-update-manifest.sig`:

```powershell
pnpm run desktop:release:sign -- --directory dist-desktop/release --private-key .desktop-local/shell-signing/desktop-update-private.pem --version 1.0.4-preview.3 --tag desktop-v1.0.4-preview.3 --channel preview --source-commit <40-hex-commit>
```

[`sync-upstream-runtime.yml`](../../.github/workflows/sync-upstream-runtime.yml) and [`windows-runtime-release.yml`](../../.github/workflows/windows-runtime-release.yml) are the authoritative runtime synchronization and publication paths. [`windows-desktop-release.yml`](../../.github/workflows/windows-desktop-release.yml) is the authoritative clean Windows build and packaged-smoke path for a `desktop-v*` tag; it uploads only the unsigned four-file candidate with repository read permission. The release operator publishes the locally signed five-file set only after that tag workflow succeeds.

## Current limits

The personal MVP has no Authenticode identity; Windows may therefore show an untrusted-publisher warning even though Harness runtime and desktop release artifacts are independently authenticated by embedded Ed25519 keys and SHA-256 digests.

Harness runtime updates remain full self-contained archives. Electron may use the published NSIS blockmap for transfer efficiency, but the shell-update MVP has no automatic shell rollback: a download or verification failure keeps the current shell running, and an installer failure is retried explicitly.

## Community links

- [Linux.do](https://linux.do/)
