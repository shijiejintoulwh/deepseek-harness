# DeepSeek Harness Desktop

English | [中文](README.zh.md)

`dsh-desktop` is a private Windows Electron host for the ordinary Harness Web profile.

The host owns installation, runtime selection, process supervision, native prompts, and rollback; Harness features continue to come from an independently versioned `dsh web` runtime.

## Release ownership

Desktop source and installer releases live on `dev-windesktop` under `desktop-v*` tags, while verified Harness runtime releases are built from `master` under immutable `runtime-v<harnessVersion>-r<revision>` tags in `shijiejintoulwh/deepseek-harness`.

The desktop package is private and deliberately excluded from the npm dsh release family.

The [upstream sync workflow](../../.github/workflows/sync-upstream-runtime.yml) runs every six hours from the fork's default `master` branch. It merge-syncs `deepseek-ai/deepseek-harness` into fork `master` and `dev-windesktop` without rewriting either branch; when official `master` advances, it calls the runtime workflow with the exact post-merge commits and publishes the next packaging revision automatically. Packaging tools come from `dev-windesktop`, while the production dependency closure and signed source commit come only from `master`. A conflict or any build, smoke, signing, or publication failure stops the release; the next run detects a synchronized `master` commit with no release target and retries the unfinished publication.

Automatic operation requires both workflow files on the default branch, GitHub Actions workflow permissions set to read and write, and `RUNTIME_SIGNING_PRIVATE_KEY_PEM` in the `runtime-release` environment. Required reviewers on that environment intentionally turn signing back into a manual approval step.

The runtime workflow emits one self-contained Windows x64 ZIP, `runtime-manifest.json`, and an Ed25519 detached signature; the manifest binds the Harness version, packaging revision, source commit, Node version, archive size, SHA-256 digest, minimum desktop version, and desktop protocol version.

The desktop installer bundles one verified release set as an offline seed, so first launch does not depend on GitHub availability.

## Storage and lifecycle

The assisted NSIS installer is per-user, does not request elevation, and lets the user choose the shell installation directory.

The installer, uninstaller, executable, shortcuts, and Electron windows use the multi-size blue DeepSeek Harness icon in `build/icon.ico`.

Electron user data, including the desktop-specific `DSH_HOME`, is stored under `%APPDATA%\DeepSeekHarnessDesktop`; versioned runtimes and the atomic selection document are stored under `%LOCALAPPDATA%\DeepSeekHarnessDesktop` and never under the selected installation directory.

The main window waits for its sandboxed CommonJS preload to report the Web application's resolved color scheme and whether the persisted preference follows the operating system. The host validates the sending window and fixed report fields before applying Electron's native theme and the matching BrowserWindow background, so the Windows title bar, application menu, dialogs, and Web content switch together without exposing an Electron API to the page.

Closing the main window hides it in the Windows notification area while the Harness runtime keeps running. Clicking the tray icon restores and focuses the window; its context menu opens the window, checks for Harness updates, or performs an explicit full exit. The first intercepted close displays a quiet notification explaining how to exit.

On first launch, the host offers to copy an existing CLI Harness home into the desktop-specific home without modifying the source. Rebuildable `node_modules` trees are omitted instead of following package-manager junctions, and every link outside those dependency trees is rejected. An empty home left by an interrupted import can be retried directly; if desktop data already exists, the host offers once to preserve it as a sibling backup before importing and automatically restores it if the replacement import fails.

The host starts the selected runtime with its bundled Node 24 executable, accepts only the announced `http://127.0.0.1` origin, waits for the real Web shell health marker, and waits for the child process and log stream to settle before exit or relaunch.

At startup the host checks the latest `runtime-v*` release, prompts before downloading, verifies the Ed25519 signature before parsing metadata, enforces compatibility, verifies size and SHA-256, rejects unsafe ZIP paths and links, and installs into a fresh version directory before staging it for restart. Discovery prefers the anonymous GitHub REST feed; when GitHub reports a rate limit, the host honors its reset time and uses the public Releases Atom feed with direct signed-asset URLs instead of repeating the blocked REST request. If both discovery paths are unavailable, a manual check reports an estimated retry interval while the automatic check remains silent.

Upstream synchronization and release publication are unattended; installation on a personal machine keeps the existing download and restart confirmations so a background check cannot consume bandwidth or interrupt active work without consent.

A candidate becomes active only after its page loads and remains alive for 30 seconds; failed candidate launches retain the current runtime, two failed attempts reject the candidate, and the menu can swap the current and previous versions for a manual rollback.

## Local build

Generate the signing pair once into the ignored local directory, then embed the public key in [`src/config.ts`](src/config.ts) and protect the private PEM as the `RUNTIME_SIGNING_PRIVATE_KEY_PEM` secret in the `runtime-release` GitHub environment:

```powershell
pnpm exec tsx scripts/runtime-release/generate-signing-key.ts --out .desktop-local/runtime-signing
```

From a built Windows x64 checkout using Node 24, create and verify the release set, copy it as the offline seed, and package the installer:

```powershell
pnpm exec tsx scripts/runtime-release/build-windows-runtime.ts --private-key .desktop-local/runtime-signing/runtime-signing-private.pem
pnpm exec tsx scripts/runtime-release/prepare-desktop-seed.ts --from dist-desktop/runtime
pnpm run desktop:dist
```

[`sync-upstream-runtime.yml`](../../.github/workflows/sync-upstream-runtime.yml), [`windows-runtime-release.yml`](../../.github/workflows/windows-runtime-release.yml), and [`windows-desktop-release.yml`](../../.github/workflows/windows-desktop-release.yml) are the authoritative synchronization and publication paths. The automated build job receives no signing secret; a protected checkout-free job validates the strict manifest fields, source commit, target, revision, compatibility, complete file set, archive size, and SHA-256 before signing those exact manifest bytes.

## Current limits

The personal MVP has no Authenticode identity; Windows may therefore show an untrusted-publisher warning even though every Harness runtime is independently authenticated by the embedded Ed25519 key and SHA-256 digest.

Only full self-contained runtime archives are supported; delta updates and automatic Electron-shell updates are deferred.
