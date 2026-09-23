# Agent Note: Upstream runtime sync preserves the fork workflow tree

Status: implemented

English | [中文](2026-08-31-runtime-sync-workflow-tree.zh.md)

## Problem

The scheduled and manual runtime sync merges upstream `master` with the repository's contents-only `GITHUB_TOKEN`. Upstream workflow edits can conflict with this fork's workflow tree before a merge commit exists. Even a conflict-free merge cannot push changed workflow files with that token, so runtime packaging never starts.

## Decision

The sync helper performs a no-fast-forward merge without committing. It accepts unresolved paths only under `.github/workflows` or in the fork-owned `scripts/ci-workflow.spec.ts`, restores those files from the first parent, and commits the merge. Any runtime source conflict stops the job before a push. The resulting commit keeps the upstream runtime source and this fork's release wiring, so the contents-only token can push `master` and package the exact merged source commit.

## Alternatives considered

**Grant the workflow token workflow-file permission.** Rejected: the permission requires a separately managed token or repository secret and is not available from the default `GITHUB_TOKEN` permission declaration.

**Skip the upstream merge when workflow files changed.** Rejected: the runtime branch would stop receiving official source updates merely because upstream also changed its control-plane files.

**Prefer the fork for every merge conflict.** Rejected: an automatic choice in runtime source can silently discard a security or lifecycle fix from upstream.

**Manually list individual workflow files to restore.** Rejected: a complete directory restore also covers upstream-added and removed workflow files without allowing control-plane drift.

## Consequences

Runtime source and package metadata advance with upstream when the source merge is clean; source conflicts require reviewed resolution. The fork retains `.github/workflows` and its workflow tests. The merge commit is the source SHA passed to the Windows runtime release, so its release metadata identifies the exact tree that was packaged. Changes intended for this fork's workflows still land through ordinary authenticated branch pushes.
