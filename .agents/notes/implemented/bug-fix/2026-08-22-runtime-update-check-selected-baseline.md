# Agent Note: Runtime update checks compare against the selected runtime

Status: implemented

English | [中文](2026-08-22-runtime-update-check-selected-baseline.zh.md)

## Problem

After a user accepted a Harness update and restarted, the desktop re-offered the same release on the next launch: the update dialog announced the exact version the app was running. `RuntimeUpdater.check` compared the remote latest against `state.active`, but a freshly updated runtime starts as `pending` and is committed to `active` only after the 30-second stability interval owned by the [versioned Windows desktop runtime](../architecture/2026-08-15-versioned-windows-desktop-runtime.md) design. The automatic check fires 2 seconds after launch, inside that window, and sessions shorter than the interval never commit the pending runtime at all — so during development the dialog reappeared on every launch while the preview shell already displayed the latest version.

## Decision

`RuntimeUpdater.check` reads the manifest of `selectedRuntimeId(state)` — `pending ?? active` — as its comparison baseline: the runtime the desktop is actually running. A release at or below the selected runtime reports `none` even before the pending candidate is committed; a genuinely newer release still reports `available` or `desktop-required`. When a pending candidate fails to launch and the desktop falls back to `active`, the recorded failure state clears or retries the selection, so the baseline keeps tracking what runs.

## Alternatives considered

**Suppress the automatic check while a pending runtime is unsettled.** A time-based suppression in `main.ts` hides genuinely newer releases that supersede the pending one and spreads the update rule across the orchestrator instead of the checker.

**Commit the pending runtime to `active` immediately on launch.** This removes the stability interval that protects users from a runtime that starts and immediately exits, dismantling the rollback design.

**Remember the last offered release in durable state.** Adds an updater-state field purely to mask a wrong baseline; the selected runtime already carries the answer.

## Consequences

The update dialog never offers a release the desktop is already running, at the cost of deferring an update notice by up to the stability interval in the rare case where the pending runtime is itself superseded before commit. A user who skipped a version stays skipped; failure fallback restores offers once `pending` clears. `apps/desktop/tests/updater.spec.ts` pins the four paths: pending equal to latest, active equal to latest, selected older than latest, and a newer release superseding the staged pending runtime.
