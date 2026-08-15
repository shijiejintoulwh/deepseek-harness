# Agent Note: Independently versioned Windows desktop runtime

Status: implemented

English | [中文](2026-08-15-versioned-windows-desktop-runtime.zh.md)

## Problem

The Windows product needs an installable shell whose installation directory is user-selectable, while the Harness program must continue following reviewed `master` changes without requiring a new Electron installer for every Harness release.

Updating files in place would leave no trustworthy last-known-good version, and downloading npm packages at application startup would make the installed product depend on mutable registry resolution, package scripts, and the user's Node installation.

The fork also needs a clear ownership boundary: desktop-only code remains on `dev-windesktop`, while the runtime is produced from reviewed `master` commits.

## Decision

[`apps/desktop`](../../../../apps/desktop/README.md) is a private Electron host with version `1.x`; it is excluded from the npm dsh release family, whose publishable applications remain `apps/cli` and `apps/web` under the [npm release decision](../process/2026-08-10-npm-release-sequences.md).

The shell is released manually from `dev-windesktop` as `desktop-v*`; ordinary shell updates are not automatic.

The [runtime workflow](../../../../.github/workflows/windows-runtime-release.yml) can run only from `master` and deploys the production closure of `@deepseek-ai/dsh` into a symlink-free hoisted tree, copies an official Node 24 executable and notices, starts the staged `dsh web` to prove the real Web shell, then archives the exact tree.

Each runtime release is an immutable `runtime-v<harnessVersion>-r<revision>` GitHub Release with an archive, exact JSON manifest, and detached Ed25519 signature.

The shell embeds the public key and verifies the signature before parsing a strict manifest; the signed fields bind platform, architecture, Harness version, packaging revision, commit SHA, Node version, asset name and size, SHA-256, minimum desktop version, exact desktop protocol version, and publication time.

Download and extraction are bounded, use staging files and directories, reject unknown manifest fields, path traversal, duplicate unsafe names, and ZIP links, and never follow a link during owned-tree cleanup.

The assisted NSIS installer is per-user, requests no elevation, and permits a custom shell directory; the seed runtime is an extra resource so first launch works offline. A multi-size ICO derived from the repository's blue favicon brands the installer, uninstaller, executable, shortcuts, and application windows.

Electron user data and the desktop-specific Harness home live under `%APPDATA%\DeepSeekHarnessDesktop`, while versioned runtimes and their atomic state live under `%LOCALAPPDATA%\DeepSeekHarnessDesktop`, independent of the shell installation directory.

This applies the existing [single Harness-home resolver](2026-07-24-single-harness-home-resolver.md): the host supplies its dedicated directory through `DSH_HOME` rather than introducing a second resolver, and first launch may copy an existing home after explicit consent without changing the source. The import omits rebuildable `node_modules` trees rather than following their package-manager links and rejects links everywhere else. An absent or empty desktop home can be replaced directly; after separate desktop data exists, a one-time explicit choice first preserves it as a random sibling backup, restores that backup if import fails, and records either decision so later launches do not keep prompting.

Runtime state retains `active`, `previous`, and `pending` identifiers plus the pending failure count and skipped release.

An update is installed beside existing versions and staged for a user-confirmed restart; a candidate becomes active only after its Web page loads and remains live for 30 seconds, a failed launch leaves the active version unchanged, two failures reject the pending candidate, and the user can explicitly swap active and previous versions.

The host launches only the bundled runtime Node, accepts only a declared `http://127.0.0.1` URL with the Web shell marker, contains renderer navigation to that origin, and waits for the exact child process tree and log stream to settle before exit or relaunch.

## Alternatives considered

**Update Electron and Harness as one product.** Rejected because every reviewed Harness change would require a much larger installer release and would couple the stable native shell to the faster runtime cadence.

**Install the latest npm packages in place.** Rejected because resolution is mutable, may execute package lifecycle scripts, depends on external Node and pnpm state, and offers no authenticated complete artifact to retain for rollback.

**Replace the current runtime directory.** Rejected because interruption or launch failure can destroy the only working version; immutable version directories make activation an atomic state change.

**Reuse the CLI home directly.** Rejected because desktop rollback and experimentation must not mutate command-line state implicitly; explicit one-time copy preserves user choice and the one-resolver policy.

**Ship delta updates in the first release.** Rejected until a complete self-contained release path and rollback state are proven; a later delta format must still authenticate the reconstructed complete artifact.

## Consequences

Harness releases can advance independently of the shell, work from an offline seed on first launch, and retain one last-known-good runtime for automatic or manual rollback.

The signing private key becomes release infrastructure: it must remain outside the repository, be stored as `RUNTIME_SIGNING_PRIVATE_KEY_PEM` in the protected `runtime-release` environment, and be rotated only together with a shell release embedding the new public key.

Full archives cost more download and disk than deltas, and the first seed install must unpack a production dependency tree; the hoisted symlink-free layout limits that cost without changing the runtime closure.

The personal MVP has no Authenticode identity, so Windows may warn about the installer even though runtime content is cryptographically authenticated.

GitHub availability and anonymous API limits affect update discovery, but not first launch or the currently installed runtime.
