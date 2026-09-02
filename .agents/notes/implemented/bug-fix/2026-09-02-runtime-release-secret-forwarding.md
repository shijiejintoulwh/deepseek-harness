# Agent Note: Runtime sync forwards repository secrets to the called release workflow

Status: implemented

English | [中文](2026-09-02-runtime-release-secret-forwarding.zh.md)

## Problem

Every automated runtime release failed in the sign job with `RUNTIME_SIGNING_PRIVATE_KEY_PEM is not configured`, although the secret exists at repository level and manually dispatched `windows-runtime-release.yml` runs sign successfully. A called reusable workflow cannot see the caller's repository-level secrets unless the caller forwards them, so the sign job's `secrets.RUNTIME_SIGNING_PRIVATE_KEY_PEM` evaluated to an empty string on the schedule and push paths while direct dispatches kept working.

## Decision

The `release` job in `sync-upstream-runtime.yml` now declares `secrets: inherit` when it calls `windows-runtime-release.yml`, forwarding the repository-level signing key to the sign job. `scripts/ci-workflow.spec.ts` pins the forwarding so the automated path cannot silently lose access to the key again.

## Alternatives considered

**Copy the signing key into the `runtime-release` environment.** Rejected: environment secrets do reach the called workflow's sign job, but the key lives only as the repository-level secret uploaded on 2026-08-17 and the local private PEM no longer exists, so it cannot be copied without regenerating the key pair and invalidating every installed desktop's trust.

**Sign inside the sync workflow instead of the called workflow.** Rejected: signing belongs to the checkout-free, environment-scoped sign job that the release workflow already isolates from build credentials.

## Consequences

Scheduled and push-triggered syncs can sign and publish runtime releases unattended, matching the direct-dispatch path that already worked. The `runtime-release` environment remains the protection seam for signing: adding required reviewers there still turns publication into an approved step without further workflow changes.
