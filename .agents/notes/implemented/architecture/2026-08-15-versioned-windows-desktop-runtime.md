# Agent Note: Independently versioned Windows desktop runtime

Status: implemented

English | [中文](2026-08-15-versioned-windows-desktop-runtime.zh.md)

## Problem

The Windows product needs an installable shell whose installation directory is user-selectable, while the Harness program must continue following official `master` changes without requiring a new Electron installer for every Harness release.

Updating files in place would leave no trustworthy last-known-good version, and downloading npm packages at application startup would make the installed product depend on mutable registry resolution, package scripts, and the user's Node installation.

The fork also needs a clear ownership boundary: desktop-only code remains on `dev-windesktop`, while the runtime is produced from fork `master` after it incorporates official `master`.

## Decision

[`apps/desktop`](../../../../apps/desktop/README.md) is a private Electron host with version `1.x`; it is excluded from the npm dsh release family, whose publishable applications remain `apps/cli` and `apps/web` under the [npm release decision](../process/2026-08-10-npm-release-sequences.md).

The shell is released from `dev-windesktop` as `desktop-v*`. Its independent [in-app shell updater](../feature/2026-08-21-windows-desktop-shell-updates.md) preserves the shell/runtime ownership split: stable and preview channels advance the Electron installation without replacing versioned Harness runtime state. A preview shell keeps the same SemVer prerelease suffix in its package metadata and tag, while a stable shell omits both.

`desktop-landing` is a dependency-free static page for the community Windows release. Its first screen, project notice, and footer identify the application as community-maintained and not an official DeepSeek desktop client. Separate links name the official Harness website, the upstream repository, and the community desktop branch; the Windows button points to one reviewed versioned installer rather than resolving a mutable download in the browser.

The page ships Chinese and English copy in the same static artifact. Its client-side language switch updates visible text, page metadata, accessibility labels, and the language-specific desktop README link, then remembers the selection locally without adding a network dependency.

The [upstream sync workflow](../../../../.github/workflows/sync-upstream-runtime.yml) is defined on the fork's default branch and runs every six hours. Scheduled and manual runs merge-sync official `master` only into fork `master` without rewriting it, while a `master` push packages that exact pushed commit. The workflow fetches `dev-windesktop` and resolves `origin/dev-windesktop` as a read-only tooling ref; it never checks out, merges, or pushes the desktop branch. An official advance triggers a runtime release from the exact post-merge source commit and pinned tooling commit, while a manual dispatch may force another packaging revision without an upstream change. The workflow executes those packaging tools against a separate source checkout, so the production dependency closure and signed source commit come only from `master`. Each run compares release target commits, so a later job failure after `master` synchronization leaves the missing release eligible for retry.

The [runtime workflow](../../../../.github/workflows/windows-runtime-release.yml) deploys the production closure of `@deepseek-ai/dsh` into a symlink-free hoisted tree, copies an official Node 24 executable and notices, starts the staged `dsh web` to prove the real Web shell, then archives the exact tree. This build job receives no signing secret. A protected checkout-free job validates the manifest field set, source commit, target, revision, compatibility, complete file set, archive size, and SHA-256, signs those exact manifest bytes, and publishes the next unused revision only after every prior job succeeds.

Each runtime release is an immutable `runtime-v<harnessVersion>-r<revision>` GitHub Release with an archive, exact JSON manifest, and detached Ed25519 signature.

The shell embeds the public key and verifies the signature before parsing a strict manifest; the signed fields bind platform, architecture, Harness version, packaging revision, commit SHA, Node version, asset name and size, SHA-256, minimum desktop version, exact desktop protocol version, and publication time.

Download and extraction are bounded, use staging files and directories, reject unknown manifest fields, path traversal, duplicate unsafe names, and ZIP links, and never follow a link during owned-tree cleanup.

The assisted NSIS installer is per-user, requests no elevation, and permits a custom shell directory; the seed runtime is an extra resource so first launch works offline. A multi-size ICO derived from the repository's blue favicon brands the installer, uninstaller, executable, shortcuts, and application windows.

The runtime theme presenter writes the persisted theme preference beside its resolved light/dark body attribute. A sandboxed CommonJS preload observes only those attributes and sends a fixed report to the main process; the host accepts it only from the main Harness window, validates the field set and value relationship, then updates Electron's `nativeTheme` and the BrowserWindow base background before showing the window. A `system` preference remains `system` instead of being collapsed into the currently resolved palette, so later operating-system changes still propagate through the Web theme runtime.

The main window is retained by a Windows notification-area icon. An ordinary window close is canceled after it hides the window, while the tray icon and a second application launch restore and focus it. File-menu or tray-menu exit, runtime relaunch, and Windows session end bypass hiding; explicit exit first waits for the runtime process tree and log stream to settle, then destroys the tray resource and terminates the shell.

Electron user data and the desktop-specific Harness home live under `%APPDATA%\DeepSeekHarnessDesktop`, while versioned runtimes and their atomic state live under `%LOCALAPPDATA%\DeepSeekHarnessDesktop`, independent of the shell installation directory.

This applies the existing [single Harness-home resolver](2026-07-24-single-harness-home-resolver.md): the host supplies its dedicated directory through `DSH_HOME` rather than introducing a second resolver, and first launch may copy an existing home after explicit consent without changing the source. The import omits rebuildable `node_modules` trees rather than following their package-manager links and rejects links everywhere else. An absent or empty desktop home can be replaced directly; after separate desktop data exists, a one-time explicit choice first preserves it as a random sibling backup, restores that backup if import fails, and records either decision so later launches do not keep prompting.

Runtime state retains `active`, `previous`, and `pending` identifiers plus the pending failure count and skipped release.

The application menu's `about-harness` item reads the installed manifest for the runtime selected by `started.selectedId` before its process starts. This is the pending candidate during validation and otherwise the active runtime, so the dialog identifies the process the shell actually launched instead of assuming `active`. It displays the Harness semantic version and packaging revision beside the Electron host version; copied diagnostics also include the runtime source commit and bundled Node version. Opening the dialog performs no update discovery or network request.

Runtime discovery prefers GitHub's anonymous Releases REST endpoint. A REST rate-limit response records its retry time and switches the provider to the public Releases Atom feed for the cooldown; feed tags derive direct manifest, signature, and archive URLs, while the existing Ed25519 signature and strict manifest remain the authority for every candidate. If the fallback also fails, a manual check reports an estimated retry interval and automatic discovery remains silent.

An update is installed beside existing versions after download confirmation and staged for a user-confirmed restart; a candidate becomes active only after its Web page loads and remains live for 30 seconds, a failed launch leaves the active version unchanged, two failures reject the pending candidate, and the user can explicitly swap active and previous versions. Upstream synchronization and publication are unattended, but a background client check cannot consume bandwidth or interrupt active work without consent.

The host launches only the bundled runtime Node with `--no-open`, accepts only a declared `http://127.0.0.1` URL with the Web shell marker, contains renderer navigation to that origin, and waits for the exact child process tree and log stream to settle before exit or relaunch. A runtime that predates browser launching also predates `--no-open`, so the host retries without the option only after that exact option is rejected. The main process denies every popup request and cross-origin top-level navigation; the sandboxed preload forwards an external HTTP(S) target only after a trusted user activation, and the main process revalidates its sender and URL before opening the default browser.

## Verification

Focused tests pin REST rate-limit parsing, cooldown behavior, Atom fallback, direct signed-asset verification, update diagnostics, version-field mapping, dialog and clipboard text, close interception, explicit-exit pass-through, window restoration, runtime `--no-open`, and trusted external-link filtering. Workflow tests pin the six-hour schedule, exact-commit `master` push releases, merge-only scheduled `master` updates, read-only desktop tooling selection, automatic revision selection, secret-free build, protected checkout-free signing, publication dependency, and desktop package, tag, and prerelease alignment. The packaged desktop smoke requires the native About item, proves the runtime did not request a browser and a scripted external popup is denied, closes the real BrowserWindow, and fails unless the real Tray retains it before process and log quiescence.

## Alternatives considered

**Update Electron and Harness as one product.** Rejected because every reviewed Harness change would require a much larger installer release and would couple the stable native shell to the faster runtime cadence.

**Install the latest npm packages in place.** Rejected because resolution is mutable, may execute package lifecycle scripts, depends on external Node and pnpm state, and offers no authenticated complete artifact to retain for rollback.

**Download an upstream npm package or release directly into the desktop.** Rejected because upstream does not publish this signed, self-contained Windows runtime format, and a client-side package build would lose the isolated verification and rollback artifact.

**Force-reset fork branches to official `master`.** Rejected because it would delete fork-owned workflow and desktop history. Fork `master` uses merge-only synchronization, while `dev-windesktop` changes only through reviewed desktop work.

**Merge official `master` into `dev-windesktop` automatically.** Rejected because runtime packaging only copies the tooling directory from that branch into a separate source checkout. Merging upstream into the desktop branch would make unrelated source conflicts block unattended publication and could alter reviewed shell code without contributing a runtime build input.

**Give the signing secret to the repository build checkout.** Rejected because automatically synchronized source and its dependency scripts must not receive the long-lived release key. The checkout-free signer accepts only an artifact and performs its own manifest-to-archive verification.

**Replace the current runtime directory.** Rejected because interruption or launch failure can destroy the only working version; immutable version directories make activation an atomic state change.

**Reuse the CLI home directly.** Rejected because desktop rollback and experimentation must not mutate command-line state implicitly; explicit one-time copy preserves user choice and the one-resolver policy.

**Ship delta updates in the first release.** Rejected until a complete self-contained release path and rollback state are proven; a later delta format must still authenticate the reconstructed complete artifact.

**Replace the native frame and menu with HTML controls.** Rejected because matching Windows movement, resizing, keyboard menus, accessibility, system buttons, and high-contrast behavior would create a second window-management implementation. Electron's native theme keeps those operating-system behaviors while removing the light/dark discontinuity.

**Require GitHub credentials for public update discovery.** Rejected because a personal access token would add setup and secret-storage obligations to downloads that are already authenticated by the embedded signing key. The public Atom fallback preserves keyless discovery without weakening artifact verification.

**Quit when the main window closes.** Rejected because desktop users commonly expect a long-running agent application to remain available in the notification area. Explicit exit remains visible in both the application and tray menus and retains the existing quiescent shutdown path.

**Present the community installer as an official product page.** Rejected because matching the official visual language must not imply official distribution, maintenance, or endorsement. The page uses an independent desktop-window motif and repeats the ownership statement where visitors evaluate the download.

**Resolve the latest installer through the GitHub API in the browser.** Rejected because an anonymous client-side request can be rate-limited and would make the primary download depend on JavaScript and remote response fields. Each shell release updates the explicit version, asset URL, and checksum link together.

**Show only Electron's application version.** Rejected because that identifies the independently released shell, not the Harness runtime whose behavior the user is running and updating.

**Render desktop version information in the ordinary Web settings page.** Rejected because the same Web profile runs outside Electron, while the selected runtime manifest and shell version are native-host data. The native application menu exposes them without adding a privileged Electron API to the page.

**Open every renderer-requested HTTP(S) popup in the default browser.** Rejected because startup code and page scripts can request navigation without user intent. Fixed popup denial plus a trusted-activation path keeps external browsing explicit.

## Consequences

Official Harness advances can produce a verified fork release without manual synchronization or packaging, independently of the shell. First launch still works from an offline seed, and the host retains one last-known-good runtime for automatic or manual rollback.

Users can distinguish the running Harness version from the desktop shell version while offline and copy the signed release identifiers needed for diagnostics.

The workflow must exist on the fork's default branch, GitHub Actions needs write permission for `master` and release updates, and the `runtime-release` environment must expose the signing secret without required reviewers for unattended operation. A `master` merge, build, smoke, signing, or publication failure prevents a new runtime release; `master` synchronization may already have completed before a later release job fails. A maintainer can push reviewed upstream versions to `master` one at a time to publish each exact version instead of collapsing multiple advances into the newest upstream head. The tooling ref remains on `dev-windesktop`, so packaging changes require an intentional desktop-branch update; stale tooling may fail the build, but upstream synchronization never mutates desktop source.

The Windows title bar, application menu, dialogs, and Web page follow one live theme without giving the page privileged Electron APIs. Runtime releases consumed by this shell preserve the two theme body attributes; older runtimes without the preference attribute still synchronize their resolved palette but cannot distinguish `system` from an explicit selection.

The signing private key becomes release infrastructure: it must remain outside the repository, be stored as `RUNTIME_SIGNING_PRIVATE_KEY_PEM` in the protected `runtime-release` environment, and be rotated only together with a shell release embedding the new public key. Full automation trusts official upstream changes after the frozen-dependency build and smoke gates; it does not grant those checked-out changes access to the signing key.

Full archives cost more download and disk than deltas, and the first seed install must unpack a production dependency tree; the hoisted symlink-free layout limits that cost without changing the runtime closure.

The personal MVP has no Authenticode identity, so Windows may warn about the installer even though runtime content is cryptographically authenticated.

Only an explicit external-link activation leaves the desktop window. A page that needs to open a browser without user activation gives up that behavior.

Hiding the main window keeps the runtime process and its memory resident until the user selects an explicit exit. A one-shot tray notification makes that persistence visible without interrupting every close.

GitHub availability can still make both discovery paths fail, but anonymous REST exhaustion alone does not block discovery, first launch, or the currently installed runtime. The Atom fallback exposes less release metadata than REST, so signed manifest fields, not feed prose, remain the only input to compatibility and installation decisions.

The static community page can be opened without a build step and deployed on any file host. Visitors can switch languages without leaving the page, and their selection persists across reloads when browser storage is available. A shell release must update its visible version and versioned asset links; this deliberate maintenance point keeps the download destination reviewable and functional when anonymous GitHub API capacity is exhausted.
