# Agent Note: Windows runtime deploy injects vendored peer packages

Status: implemented

## Problem

The Windows runtime release builds from fork `master`, where `pnpm --filter @deepseek-ai/dsh deploy --prod` omits vendored framework packages that appear only as peer dependencies of workspace entries; `@deepseek-ai/cordis-plugin-group` is the first such import in `dsh-app-boot`. The deployed tree then fails its staged `dsh web` launch with `ERR_MODULE_NOT_FOUND`, so no `runtime-v*` release can be published and the desktop shell's runtime update channel stays empty.

## Decision

[`build-windows-runtime.ts`](../../../../scripts/runtime-release/build-windows-runtime.ts) injects missing vendored packages after the production deploy: every package under `vendor/` whose install path is absent from the deployed `node_modules` is copied there in its publishable form — `package.json`, license and readme files, `bin.js`, `lib`, `src` — refusing links so the archive stays self-contained. Packages pnpm already injected are left untouched, and the existing link-escape assertion and runtime smoke launch still gate the completed tree. The fix lives with the packaging tools on `dev-windesktop`; the [runtime workflow](../../../../.github/workflows/windows-runtime-release.yml) copies those tools into the source checkout, so fork `master` carries no tooling-side dependency edits.

## Verification

The runtime workflow's build job runs the injection against fork `master`, and the staged `dsh web` launch proves the completed closure; a missing vendored import fails the build before any archive or manifest is produced.

## Alternatives considered

**Adding the vendored packages to `apps/cli` dependencies on fork `master`.** Rejected: fork `master` mirrors official `master` through merge-only synchronization, and dependency edits there would conflict with future upstream merges and diverge published npm metadata.

**Deploying a second filtered closure and merging the trees.** Rejected: `pnpm deploy` targets one package, and merging two hoisted trees would duplicate external dependencies without proving completeness. Copying exactly the absent vendored packages keeps one authoritative deploy result.

## Consequences

Upstream may add or re-scope vendored packages without breaking the Windows runtime build; injection follows `vendor/` automatically. Vendored packages still need a built `lib/` before the copy, which the build step preceding deploy produces. This extends the packaging path of the [versioned Windows desktop runtime](../architecture/2026-08-15-versioned-windows-desktop-runtime.md).
