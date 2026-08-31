# Agent Note: Upstream runtime sync preserves the fork workflow tree

Status: implemented

English | [中文](2026-08-31-runtime-sync-workflow-tree.zh.md)

## Problem

The scheduled and manual runtime sync merges upstream `master` with the repository's contents-only `GITHUB_TOKEN`. When an upstream merge includes changes under `.github/workflows`, GitHub rejects the push because that token cannot create or update workflow files, so runtime packaging never starts.

## Decision

After the no-fast-forward upstream merge, restore the complete `.github/workflows` tree from the merge's first parent and amend the merge commit only when that tree changed. The resulting commit keeps the upstream runtime source while retaining this fork's release wiring, then the contents-only token can push `master` and the runtime workflow can package the exact amended source commit.

## Alternatives considered

**Grant the workflow token workflow-file permission.** Rejected: the permission requires a separately managed token or repository secret and is not available from the default `GITHUB_TOKEN` permission declaration.

**Skip the upstream merge when workflow files changed.** Rejected: the runtime branch would stop receiving official source updates merely because upstream also changed its control-plane files.

**Manually list individual workflow files to restore.** Rejected: a complete directory restore also covers upstream-added and removed workflow files without allowing control-plane drift.

## Consequences

Runtime source and package metadata continue to advance with upstream, while `.github/workflows` remains fork-owned. The amended merge commit is the source SHA passed to the Windows runtime release, so its release metadata identifies the exact tree that was packaged. Changes intended for this fork's workflows still land through ordinary authenticated branch pushes.
