import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = '${{ runner.temp }}/setup-pnpm'

describe('CI workflow', () => {
  it('isolates every pnpm action setup destination per runner', () => {
    const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'))
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')

    const setups = Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
      if (!isRecord(job) || !Array.isArray(job.steps)) return []
      return job.steps.flatMap((step) => {
        if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) return []
        return [{ jobName, step }]
      })
    })

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      expect(step, `${jobName} must not share pnpm/action-setup's default destination`).toMatchObject({
        with: { dest: runnerPrivatePnpmDestination },
      })
    }
  })

  it('keeps a required Wine Windows job, a non-blocking native Windows job with failover, and a master-only standby', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)
      || !isRecord(workflow.jobs.windows)
      || !isRecord(workflow.jobs['windows-native'])
      || !isRecord(workflow.jobs['wine-apt-cache'])
      || !isRecord(workflow.jobs['serial-windows'])
      || !isRecord(workflow.jobs['node-24'])
      || !isRecord(workflow.jobs['node-24-coverage'])
      || !isRecord(workflow.jobs['node-24-consumers'])
      || !isRecord(workflow.jobs['all-checks-passed'])) {
      throw new TypeError('CI workflow must define windows, windows-native, wine-apt-cache, serial-windows, node-24, node-24-coverage, node-24-consumers, and all-checks-passed jobs')
    }

    const windows = workflow.jobs.windows
    const windowsNative = workflow.jobs['windows-native']
    const wineAptCache = workflow.jobs['wine-apt-cache']
    const serialWindows = workflow.jobs['serial-windows']
    const node24 = workflow.jobs['node-24']
    const node24Coverage = workflow.jobs['node-24-coverage']
    const node24Consumers = workflow.jobs['node-24-consumers']
    const aggregate = workflow.jobs['all-checks-passed']
    if (!Array.isArray(windows.steps) || !Array.isArray(aggregate.needs)) {
      throw new TypeError('Windows job must define steps and the aggregate must define needs')
    }
    const commandSteps = windows.steps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))

    // Required PR job: Wine on ubuntu-latest, runs wine-windows-gates.sh.
    expect(windows['runs-on']).toBe('ubuntu-latest')
    expect(windows.name).toBe('windows node 24 / wine blocking')
    expect(windows.if).toBe("github.event_name == 'pull_request'")
    expect(commandSteps.some(step => step.run.includes('wine-windows-gates.sh'))).toBe(true)

    // windows-native: non-blocking native job with failover, runs windows-complete.
    // Its pool is resolved by the Windows-specific switch.
    expect(typeof windowsNative['runs-on']).toBe('string')
    expect(windowsNative['runs-on']).toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(windowsNative['runs-on']).not.toContain('DSH_CI_FAILOVER_LINUX')
    expect(windowsNative['runs-on']).toContain('self-hosted')
    expect(windowsNative['runs-on']).toContain('dsh-win-ci')
    expect(windowsNative['runs-on']).toContain('dsh-windows-2025-16core')
    expect(windowsNative.name).toBe('windows node 24 / native complete')
    expect(windowsNative.if).toBe("github.event_name == 'pull_request'")
    const nativeCommandSteps = (windowsNative.steps as unknown[]).filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    expect(nativeCommandSteps.map(step => step.run)).toContain('pnpm run check:ci:windows-complete')

    // wine-apt-cache: master-only, seeds the Wine apt cache.
    expect(wineAptCache.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(wineAptCache['runs-on']).toBe('ubuntu-latest')

    // serial-windows: master-only standby, self-hosted, non-blocking.
    expect(serialWindows.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(serialWindows['runs-on']).toEqual(['self-hosted', 'dsh-win-ci', 'windows'])
    expect(serialWindows.name).toBe('serial / windows (self-hosted standby)')

    // Aggregate: Wine `windows` required, native `windows-native` excluded.
    expect(aggregate.needs).toContain('windows')
    expect(aggregate.needs).not.toContain('windows-native')
    expect(aggregate.needs).not.toContain('serial-windows')

    // Linux failover is a separate switch: the three required Linux workers
    // and the verdict job resolve their pool through DSH_CI_FAILOVER_LINUX,
    // never the Windows switch.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Linux failover switch`).toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on'], `${jobName} runs-on must not use the Windows failover switch`).not.toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(job['runs-on']).toContain('vm-backup')
    }
    expect(aggregate['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(aggregate['runs-on']).not.toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(aggregate['runs-on']).toContain('vm-backup')
  })

  it('exempts push from cancellation, so one master merge does not cancel the running drill', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('CI workflow must define jobs and a workflow-level concurrency block')
    }

    // Cancellation applies to the whole superseded RUN, so this has to be
    // decided at workflow level and gated on the event: a job-level group
    // cannot exempt its job from its run being cancelled. Only push is exempt —
    // a drill takes longer than the interval between master merges. The negated
    // form is load-bearing: `== 'pull_request'` would also stop cancelling
    // workflow_dispatch, and a re-dispatched runner benchmark holds up to 12
    // larger runners for 15 minutes in this same group on master. The
    // expression is evaluated against the NEWLY TRIGGERED run, so a dispatch on
    // master still cancels a mid-flight drill; the runbook records that bound.
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'push' }}")

    // Neither drill may carry a job-level group: it would not exempt the job
    // from run-scoped cancellation.
    for (const name of ['serial-linux-selfhosted', 'serial-windows']) {
      const job = workflow.jobs[name]
      if (!isRecord(job)) throw new TypeError(`${name} must be defined`)
      expect(job.concurrency).toBeUndefined()
      // Both stay master-push-only; that is what makes the push carve-out safe.
      expect(job.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    }

    // What bounds the cost of exempting push: a master push may only carry the
    // cache seeder and the two drills. Any job reachable on push would start
    // accumulating uncancelled runs, so the set is pinned here.
    //
    // Classification is an exact allowlist of the conditions in use, not a
    // substring match: `github.event_name != 'pull_request'` mentions
    // `pull_request` yet IS push-reachable, so matching on the event name alone
    // would silently misclassify it as gated.
    const NOT_PUSH_REACHABLE = new Set([
      "github.event_name == 'pull_request'",
      "always() && github.event_name == 'pull_request'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'larger-runner-benchmark'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'consolidated-runner-benchmark'",
    ])
    const pushReachable = Object.entries(workflow.jobs)
      .filter(([, job]) => {
        if (!isRecord(job)) return false
        if (job.if === undefined) return true // unconditional: runs on every event
        if (job.if === false) return false // `if: false` parses as a boolean
        if (typeof job.if !== 'string') return true // unrecognized shape: surface it
        return !NOT_PUSH_REACHABLE.has(job.if.trim())
      })
      .map(([name]) => name)
      .sort()
    expect(pushReachable).toEqual(['serial-linux-selfhosted', 'serial-windows', 'wine-apt-cache'])

    // Why workflow_dispatch must keep cancelling: each benchmark fans out to a
    // dozen larger runners at once, in this same group on master. If it stopped
    // cancelling, a re-dispatch would queue ahead of a drill instead of
    // replacing the stale measurement.
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark']) {
      const job = workflow.jobs[name]
      if (!isRecord(job) || !isRecord(job.strategy)) {
        throw new TypeError(`${name} must define a matrix strategy`)
      }
      expect(job.strategy['max-parallel']).toBe(12)
      expect(job['timeout-minutes']).toBe(15)
    }
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('requires one release-shaped Python runtime target on every pull request', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      if: "github.event_name == 'pull_request'",
      name: 'python runtime / release-shaped Linux x64',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64',
        ci: true,
      },
    })
    expect(aggregate.needs).toContain('python-runtime')
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

describe('E2B e2e workflow', () => {
  it('is manual-only and fails loud before running the focused live suite', () => {
    const workflow = loadWorkflow('.github/workflows/e2b-e2e.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.e2b) || !Array.isArray(workflow.jobs.e2b.steps)) {
      throw new TypeError('E2B e2e workflow must define the e2b job steps')
    }

    const steps = workflow.jobs.e2b.steps.filter(isRecord)
    const preflight = steps.find(step => step.name === 'Preflight (require E2B API key)')
    const e2b = steps.find(step => step.name === 'E2B tests (live sandbox)')

    expect(preflight).toMatchObject({
      env: { E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}' },
    })
    expect(preflight?.run).toContain('E2B_API_KEY_EXTERNAL repository secret')
    expect(e2b).toMatchObject({
      env: {
        E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}',
        DSH_E2E_MAX_WORKERS: '1',
        DSH_EXAMPLE_MODE: 'lib',
      },
    })
    expect(e2b?.run).toContain('packages/e2b/e2b/tests/composition.e2e.ts')
  })
})

describe('Python release workflows', () => {
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const pullRequest = workflowEvent(workflow, 'pull_request')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    expect(pullRequest).toEqual({ types: ['labeled'] })
    expect(build).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' || github.event.label.name == 'python-release-dry-run'",
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    expect(JSON.stringify(pythonCompat.steps)).toContain('deepseek-harness-sdk==${{ steps.compatibility-version.outputs.version }}')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    expect(JSON.stringify(workflow)).toContain('macosx_14_0_arm64')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('$HOME/setup-pnpm:$HOME/setup-pnpm:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(JSON.stringify(macosCheck)).toContain('scripts/check-macos-deployment-target.py')
    expect(JSON.stringify(macosCheck)).toContain('$EXE-spawn-helper')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('PLATFORM" = macos-arm64'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('"$EXE" "$EXE-spawn-helper"')
  })
})

describe('Windows runtime automation', () => {
  it('builds and validates unsigned desktop update assets without release credentials', () => {
    const workflow = loadWorkflow('.github/workflows/windows-desktop-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const push = workflowEvent(workflow, 'push')
    const build = workflowJob(workflow, 'build')
    const desktopPackage: unknown = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'))
    const builder = readFileSync(resolve(root, 'apps/desktop/electron-builder.yml'), 'utf8')
    if (!isRecord(dispatch.inputs)
      || !isRecord(desktopPackage)
      || typeof desktopPackage.version !== 'string'
      || !Array.isArray(build.steps)
      || !isRecord(workflow.jobs)) {
      throw new TypeError('Windows desktop release must define inputs, a package version, and build steps')
    }

    expect(dispatch.inputs).toMatchObject({
      'source-ref': { type: 'string', default: 'dev-windesktop' },
      'runtime-tag': { type: 'string', required: false },
      'desktop-tag': { type: 'string', default: `desktop-v${desktopPackage.version}` },
    })
    expect(dispatch.inputs).not.toHaveProperty('publish')
    expect(push.tags).toEqual(['desktop-v*'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs)).toEqual(['build'])
    expect(workflow.concurrency).toEqual({
      group: 'windows-desktop-release',
      'cancel-in-progress': false,
    })
    const buildText = JSON.stringify(build.steps)
    expect(buildText).toContain("github.event_name == 'push' && github.ref || inputs.source-ref")
    expect(buildText).toContain('scripts/desktop-release/release-config.json')
    expect(buildText).toContain('scripts/desktop-release/generate-manifest.ts')
    expect(buildText).toContain('desktop builder did not produce $name')
    expect(buildText).toContain("$builderMetadata = 'dist-desktop/latest.yml'")
    expect(buildText).toContain('(Join-Path $release $env:METADATA)')
    expect(buildText).not.toContain('DESKTOP_UPDATE_SIGNING_PRIVATE_KEY_PEM')
    expect(buildText).not.toContain('desktop-update-manifest.sig')
    expect(buildText).not.toContain('gh release create')
    expect(builder).toContain('provider: github')
    expect(builder).toContain('owner: shijiejintoulwh')
    expect(builder).toContain('repo: deepseek-harness')
    expect(builder).toContain('tagNamePrefix: desktop-v')
    expect(builder).toContain('differentialPackage: true')
  })

  it('packages exact master pushes and merge-syncs only the runtime branch', () => {
    const workflow = loadWorkflow('.github/workflows/sync-upstream-runtime.yml')
    const schedule = workflow.on
    const sync = workflowJob(workflow, 'sync')
    const release = workflowJob(workflow, 'release')
    if (!isRecord(schedule)
      || !Array.isArray(schedule.schedule)
      || !Array.isArray(sync.steps)
      || !isRecord(workflow.permissions)
      || !isRecord(workflow.concurrency)) {
      throw new TypeError('Windows runtime sync must define its schedule, jobs, permissions, and concurrency')
    }

    expect(schedule.schedule).toEqual([{ cron: '17 */6 * * *' }])
    expect(schedule.push).toEqual({ branches: ['master'] })
    expect(workflow.permissions.contents).toBe('write')
    expect(workflow.concurrency).toEqual({
      group: 'sync-upstream-windows-runtime',
      'cancel-in-progress': false,
    })

    const syncSteps = (sync.steps as unknown[]).filter(isRecord)
    const checkout = syncSteps.find(step => step.uses === 'actions/checkout@v6')
    const syncStep = syncSteps.find(step => step.name === 'Select runtime source and pin desktop tooling')
    expect(checkout).toMatchObject({
      with: {
        ref: "${{ github.event_name == 'push' && github.sha || 'master' }}",
        'fetch-depth': 0,
      },
    })
    if (!isRecord(syncStep) || typeof syncStep.run !== 'string') {
      throw new TypeError('Windows runtime sync must define its sync step')
    }
    expect(syncStep.run).toContain('https://github.com/deepseek-ai/deepseek-harness.git')
    expect(syncStep.run).toContain("if [ \"$EVENT_NAME\" = 'push' ]")
    expect(syncStep.run.match(/git merge-base --is-ancestor/g)).toHaveLength(1)
    expect(syncStep.run).toContain('git merge --no-edit --no-ff "$upstream_sha"')
    expect(syncStep.run).toContain('git checkout HEAD^ -- .github/workflows')
    expect(syncStep.run).toContain('git diff --cached --quiet -- .github/workflows || git commit --amend --no-edit')
    expect(syncStep.run).toContain('git push origin HEAD:master')
    expect(syncStep.run).toContain('source_sha=$(git rev-parse HEAD)')
    expect(syncStep.run).toContain('git fetch --no-tags origin dev-windesktop')
    expect(syncStep.run).toContain('tooling_sha=$(git rev-parse origin/dev-windesktop)')
    expect(syncStep.run).not.toContain('git checkout -B dev-windesktop')
    expect(syncStep.run).not.toContain('git push origin HEAD:dev-windesktop')
    expect(syncStep.run).toContain("--jq '.[].target_commitish'")
    expect(syncStep.run).toContain('grep -Fqx "$source_sha"')
    expect(syncStep.run).not.toContain('--force')

    expect(release).toMatchObject({
      needs: 'sync',
      if: "needs.sync.outputs.release-needed == 'true'",
      uses: './.github/workflows/windows-runtime-release.yml',
      with: {
        'source-ref': '${{ needs.sync.outputs.source-sha }}',
        'tooling-ref': '${{ needs.sync.outputs.tooling-sha }}',
        'runtime-revision': 0,
        'min-desktop-version': '1.0.0',
        publish: true,
      },
      // A called reusable workflow cannot see repository-level secrets unless
      // the caller forwards them; without this the sign job builds an empty
      // RUNTIME_SIGNING_PRIVATE_KEY_PEM and every automated release fails.
      secrets: 'inherit',
    })
  })

  it('builds without release secrets and signs only in the protected checkout-free job', () => {
    const workflow = loadWorkflow('.github/workflows/windows-runtime-release.yml')
    const call = workflowEvent(workflow, 'workflow_call')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const build = workflowJob(workflow, 'build')
    const sign = workflowJob(workflow, 'sign')
    const publish = workflowJob(workflow, 'publish')
    if (!isRecord(call.inputs)
      || !isRecord(dispatch.inputs)
      || !Array.isArray(build.steps)
      || !Array.isArray(sign.steps)
      || !Array.isArray(publish.steps)
      || !isRecord(workflow.concurrency)) {
      throw new TypeError('Windows runtime release must define its inputs, jobs, and concurrency')
    }

    expect(call.inputs).toMatchObject({
      'source-ref': { required: true, type: 'string' },
      'tooling-ref': { required: true, type: 'string' },
      'runtime-revision': { type: 'number', default: 0 },
      publish: { type: 'boolean', default: true },
    })
    expect(dispatch.inputs).toMatchObject({
      'source-ref': { type: 'string', default: 'master' },
      'tooling-ref': { type: 'string', default: 'dev-windesktop' },
      'runtime-revision': { type: 'number', default: 0 },
      publish: { type: 'boolean', default: false },
    })
    expect(workflow.concurrency).toEqual({
      group: 'windows-runtime-release',
      'cancel-in-progress': false,
    })

    const buildText = JSON.stringify(build.steps)
    const buildSteps = (build.steps as unknown[]).filter(isRecord)
    const checkouts = buildSteps.filter(step => step.uses === 'actions/checkout@v6')
    const sourceCheckout = checkouts.find(step => isRecord(step.with) && step.with.path === 'source')
    const toolingCheckout = checkouts.find(step => isRecord(step.with) && step.with.path === 'tooling')
    expect(sourceCheckout).toMatchObject({
      with: {
        ref: '${{ inputs.source-ref }}',
        'persist-credentials': false,
        path: 'source',
      },
    })
    expect(toolingCheckout).toMatchObject({
      with: {
        ref: '${{ inputs.tooling-ref }}',
        'persist-credentials': false,
        path: 'tooling',
      },
    })
    expect(buildText).toContain('gh api --paginate')
    expect(buildText.indexOf('git rev-parse HEAD')).toBeLessThan(buildText.indexOf('pnpm/action-setup@v4'))
    expect(buildText).toContain('Build and smoke-test runtime')
    expect(buildText).toContain('Copy-Item -Recurse -Force ../tooling/scripts/runtime-release scripts/runtime-release')
    expect(buildText).toContain('Get-ChildItem -Path scripts/runtime-release -Filter *.spec.ts | Remove-Item -Force')
    expect(buildText).toContain("Add-Member -NotePropertyName 'runtime:windows:build'")
    expect(buildText).toContain('pnpm run runtime:windows:build')
    expect(buildText).not.toContain('../tooling/scripts/runtime-release/build-windows-runtime.ts')
    expect(buildText).toContain('working-directory":"source')
    expect(buildText).not.toContain('RUNTIME_SIGNING_PRIVATE_KEY_PEM')
    expect(buildText).not.toContain('--private-key')

    expect(sign).toMatchObject({
      needs: 'build',
      'runs-on': 'ubuntu-latest',
      environment: 'runtime-release',
    })
    const signText = JSON.stringify(sign.steps)
    expect(signText).not.toContain('actions/checkout')
    expect(signText).toContain('RUNTIME_SIGNING_PRIVATE_KEY_PEM')
    expect(signText).toContain('EXPECTED_SOURCE_SHA')
    expect(signText).toContain('unsigned runtime artifact contains unexpected files')
    expect(signText).toContain("key.asymmetricKeyType !== 'ed25519'")
    expect(signText).toContain('size !== manifest.size || sha256 !== manifest.sha256')

    expect(publish).toMatchObject({
      if: 'inputs.publish',
      needs: ['build', 'sign'],
      permissions: { contents: 'write' },
    })
    expect(JSON.stringify(publish.steps)).toContain('gh release create')
  })

  it('executes the embedded signer against only the expected release set', () => {
    const workflow = loadWorkflow('.github/workflows/windows-runtime-release.yml')
    const sign = workflowJob(workflow, 'sign')
    if (!Array.isArray(sign.steps)) throw new TypeError('Windows runtime signer must define steps')
    const signStep = (sign.steps as unknown[])
      .filter(isRecord)
      .find(step => step.name === 'Verify release assets and sign exact manifest bytes')
    if (!isRecord(signStep) || typeof signStep.run !== 'string') {
      throw new TypeError('Windows runtime signer must define its embedded command')
    }
    const command = signStep.run.trim()
    const prefix = 'node --input-type=module -e "'
    if (!command.startsWith(prefix) || !command.endsWith('"')) {
      throw new TypeError('Windows runtime signer must keep one extractable Node command')
    }
    const signer = command.slice(prefix.length, -1)

    const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-signer-test-'))
    const runtime = join(temporary, 'dist-desktop', 'runtime')
    mkdirSync(runtime, { recursive: true })
    const harnessVersion = '0.1.0-test.1'
    const runtimeRevision = 7
    const asset = `deepseek-harness-runtime-win32-x64-${harnessVersion}-r${runtimeRevision}.zip`
    const archive = Buffer.from('verified runtime archive')
    const sourceSha = '1'.repeat(40)
    const manifest = {
      schemaVersion: 1,
      harnessVersion,
      runtimeRevision,
      platform: 'win32',
      arch: 'x64',
      asset,
      size: archive.length,
      sha256: createHash('sha256').update(archive).digest('hex'),
      commitSha: sourceSha,
      nodeVersion: 'v24.19.0',
      minDesktopVersion: '1.0.0',
      desktopProtocolVersion: 1,
      publishedAt: '2026-08-16T00:00:00.000Z',
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const signingEnvironment = {
      ...process.env,
      RUNTIME_SIGNING_PRIVATE_KEY_PEM: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      EXPECTED_MIN_DESKTOP_VERSION: '1.0.0',
      EXPECTED_RUNTIME_TAG: `runtime-v${harnessVersion}-r${runtimeRevision}`,
      EXPECTED_SOURCE_SHA: sourceSha,
    }

    try {
      writeFileSync(join(runtime, asset), archive)
      writeFileSync(join(runtime, 'runtime-manifest.json'), manifestBytes)
      const signed = spawnSync(process.execPath, ['--input-type=module', '-e', signer], {
        cwd: temporary,
        encoding: 'utf8',
        env: signingEnvironment,
      })
      expect(signed.stderr).toBe('')
      expect(signed.status).toBe(0)
      const signature = Buffer.from(readFileSync(join(runtime, 'runtime-manifest.sig'), 'utf8').trim(), 'base64')
      expect(verify(null, manifestBytes, publicKey, signature)).toBe(true)

      rmSync(join(runtime, 'runtime-manifest.sig'))
      writeFileSync(join(runtime, 'unexpected.txt'), 'must not publish')
      const rejected = spawnSync(process.execPath, ['--input-type=module', '-e', signer], {
        cwd: temporary,
        encoding: 'utf8',
        env: signingEnvironment,
      })
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain('unsigned runtime artifact contains unexpected files')
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})

describe('Issue lifecycle workflow', () => {
  it('uses explicit review handoff events without rerunning when a draft becomes ready', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const policyPullRequest = workflowEvent(policy, 'pull_request')

    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    expect(lifecycleJob.if).toBe(
      "${{ github.event_name != 'pull_request_review' || (github.event.action == 'submitted' && github.event.review.state == 'changes_requested') }}",
    )
    expect(policyPullRequest.types).toContain('ready_for_review')
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
