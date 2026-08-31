# Agent Note: Windows runtime smoke exchanges the Web launch token

Status: implemented

English | [中文](2026-08-31-windows-runtime-smoke-auth.zh.md)

## Problem

The Windows runtime smoke test opened the authenticated Web URL and required an immediate `200` response. The Web connection intentionally answers the first launch-token request with a `303` redirect that sets an authority-bound cookie, so the staged runtime could start and print its URL while every smoke probe remained unauthenticated. The build therefore stopped before signing and publishing an otherwise complete runtime archive.

## Decision

The smoke probe sends the printed URL with manual redirect handling, extracts the returned session cookie, and requests the clean loopback root with that cookie before checking for the injected `__DSH_BOOT__` marker. The child receives `--no-open` so a CI smoke test does not launch a browser. The probe remains bounded by the existing retry deadline and does not add the extracted cookie to the bounded child-output diagnostic.

## Alternatives considered

**Follow the redirect with the default fetch policy.** Rejected: Node's fetch does not retain a browser cookie jar, so the redirected clean request would still be unauthenticated.

**Disable Web authentication for the smoke process.** Rejected: the packaged runtime must prove the same launch-token and cookie exchange used by the desktop shell; bypassing it would leave the published archive untested on its real startup path.

## Consequences

The smoke test now covers the complete first-browser-request flow and can publish runtimes whose Web shell is actually reachable. The check depends on the Web launch contract remaining a `303` token exchange followed by a clean-root request; a change to that protocol must update this probe and its focused tests together.
