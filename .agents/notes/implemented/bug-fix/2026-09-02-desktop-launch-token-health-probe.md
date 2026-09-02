# Agent Note: The desktop health probe completes the runtime launch-token handshake

Status: implemented

English | [中文](2026-09-02-desktop-launch-token-health-probe.zh.md)

## Problem

Runtimes since Harness 0.1.2-alpha.3 answer the announced `dsh web` URL with a 303 redirect to `/` and a session cookie instead of serving the Web shell directly. The desktop host's startup health check fetched the announced URL with `redirect: 'error'` and required an immediate 200 response carrying `__DSH_BOOT__`, so every launch of such a runtime failed the startup deadline. `startSelectedRuntime` retried the candidate once, dropped the pending selection, and silently continued on the previous runtime: users accepted a Harness update, restarted, and still ran the old version with no log entry or dialog.

## Decision

The health probe in `runtime-process.ts` now follows the handshake: a 303 response with `location: /` is retried with the first `Set-Cookie` pair against the query-less URL, and only an authenticated 200 carrying `__DSH_BOOT__` proves the shell. A response that serves the marker directly still passes, so runtimes predating the handshake keep working. `startSelectedRuntime` records each failed candidate launch in the desktop log, and a candidate rejected after two failures is reported once at the next startup with the fallback version and reason. This mirrors the authenticated smoke probe the runtime build already uses, and the release workflow's packaged smoke test now boots the seeded runtime through the same path.

## Alternatives considered

**Have the runtime serve the shell without the handshake for loopback listeners.** Rejected: the launch token exists to keep the Web shell unauthenticated-proof; weakening it for the desktop would reopen every other `dsh web` consumer.

**Treat any reachable HTTP response as healthy and let the window load reveal failures.** Rejected: the health marker is what proves the real Web shell rather than a partial or wrong server; dropping it would move candidate failures past the two-attempt rejection path.

**Only log the rollback without a startup dialog.** Rejected: users do not read the log, and the reported bug was precisely a silent rollback that looked like a failed update.

## Consequences

Desktop 1.5.6-preview.1 and later activate runtime 0.1.2-alpha.3+ updates; older desktop hosts still silently roll back and must be upgraded through a shell update first. The probe accepts only the exact 303-to-`/` shape with a cookie pair, so any other redirect or status keeps retrying until the startup deadline. Rejected candidates remain visible in `logs/runtime.log` and the one-time startup dialog names the candidate, the fallback, and the first failure reason.
