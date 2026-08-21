# Agent Note: Windows runtime deploy completes the workspace dependency closure

Status: implemented

English | [中文](2026-08-18-windows-runtime-deploy-vendored-peers.zh.md)

## Problem

The Windows runtime release builds from fork `master`, where `pnpm --filter @deepseek-ai/dsh deploy --prod` omits packages that appear only as peer dependencies of deployed entries — vendored cordis plugins such as `@deepseek-ai/cordis-plugin-group`, and workspace libraries such as `@deepseek-ai/dsh-scope` imported by `dsh-agent-presets`. The deployed tree then fails its staged `dsh web` launch with `ERR_MODULE_NOT_FOUND`, so no `runtime-v*` release can be published and the desktop shell's runtime update channel stays empty.

## Decision

[`build-windows-runtime.ts`](../../../../scripts/runtime-release/build-windows-runtime.ts) completes the deployed tree's workspace dependency closure after the production deploy: it scans every deployed manifest's `dependencies`, `peerDependencies`, and `optionalDependencies` for names that exist as workspace packages in the checkout but have no installed directory, copies each missing package in its publishable form — manifest, notices, `bin.js`, `lib`, `src`, `config`, `cordis.patch.yml`, rejecting links — and repeats until the closure settles. Packages pnpm already installed are left untouched, and the existing link-escape assertion and runtime smoke launch still gate the completed tree. The fix lives with the packaging tools on `dev-windesktop`; the [runtime workflow](../../../../.github/workflows/windows-runtime-release.yml) copies those tools into the source checkout, so fork `master` carries no tooling-side dependency edits.

## Verification

The runtime workflow's build job runs the closure completion against fork `master`, and the staged `dsh web` launch proves the completed tree; a missing runtime import fails the build before any archive or manifest is produced.

## Alternatives considered

**Adding the missing packages to `apps/cli` dependencies on fork `master`.** Rejected: fork `master` mirrors official `master` through merge-only synchronization, and dependency edits there would conflict with future upstream merges and diverge published npm metadata. The omission also recurs for any future peer-only import, while closure completion follows the graph automatically.

**Injecting every workspace package unconditionally.** Rejected: the production archive would carry test-support and example packages nothing imports. Manifest-referenced closure injects exactly the runtime-reachable set.

## Consequences

Upstream may add, move, or re-scope workspace or vendored packages without breaking the Windows runtime build; the closure follows the deployed manifests. Injected packages still need a built `lib/`, which the build step preceding deploy produces. This extends the packaging path of the [versioned Windows desktop runtime](../architecture/2026-08-15-versioned-windows-desktop-runtime.md).
