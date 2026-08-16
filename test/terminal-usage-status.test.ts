import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import type { BraidViewModel } from '../src/views/shared/models.js'
import { activityDocument } from '../src/views/tui/activity-browser.js'
import { executionTargetFor } from '../src/views/tui/execution-target.js'
import { TerminalChrome } from '../src/views/tui/terminal-chrome.js'
import { footerMetricsFor, metricsFor } from '../src/views/tui/terminal-usage.js'
import { createBraidTheme } from '../src/views/tui/theme.js'

const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })

test('terminal usage keeps direct, analysis, and worker measurements separate and honest', () => {
  const view = usageView()
  const metrics = metricsFor(view)

  assert.deepEqual(metrics, [
    'in ≥10',
    'out ≥20',
    '≥$0.0100',
    'calls ≥2',
    'latency ≥120ms',
    'workers in 0 · out 0 · $0.0000 · calls 0 · latency 0ms',
  ])

  const context = activityDocument(view).context ?? ''
  assert.match(context, /in ≥10.*calls ≥2.*latency ≥120ms/u)
  assert.doesNotMatch(context, /analysis|unknown|missing/u)
  assert.match(context, /workers .*calls 0.*latency 0ms/u)
  assert.deepEqual(footerMetricsFor(view), ['in ≥10', 'out ≥20', '≥$0.0100', 'latency ≥120ms'])
})

test('terminal chrome keeps telemetry out of narrow layouts', () => {
  const chrome = new TerminalChrome(theme)
  chrome.setState({
    view: usageView(),
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })

  const narrow = chrome.render(40)
  assert.equal(narrow.length, 1)
  assert.doesNotMatch(narrow.join('\n'), /calls|analysis|workers|missing/u)
  for (const line of narrow) assert.ok(visibleWidth(line) <= 40)
})

test('terminal usage presents a complete estimate instead of an observed-cost floor', () => {
  const view = usageView()
  const estimated: BraidViewModel = {
    ...view,
    sessionUsage: {
      ...view.sessionUsage,
      turns: {
        ...view.sessionUsage.turns,
        costUsd: 0.1,
        estimatedCostUsd: 0.15,
        costStatus: 'estimated',
        unknownCostSources: 1,
      },
    },
  }

  assert.match(metricsFor(estimated).join(' · '), /~\$0\.1500/u)
  assert.doesNotMatch(metricsFor(estimated).join(' · '), /≥\$0\.1000/u)
  assert.doesNotMatch(footerMetricsFor(estimated).join(' · '), /\$/u)

  const freeEstimate = {
    ...estimated,
    sessionUsage: {
      ...estimated.sessionUsage,
      turns: {
        ...estimated.sessionUsage.turns,
        costUsd: 0,
        estimatedCostUsd: 0,
      },
    },
  }
  assert.match(metricsFor(freeEstimate).join(' · '), /~\$0\.0000/u)
})

test('execution identity comes from one active run receipt instead of current profile fields', () => {
  const base = usageView()
  const view: BraidViewModel = {
    ...base,
    profileName: 'Next profile',
    profileDigest: 'digest-next',
    runner: 'codex',
    model: 'openai/gpt-next',
    effort: 'medium',
    maxVisibleOutputTokens: 4096,
    maxReasoningTokens: 2048,
    maxTotalOutputTokens: 6144,
    connection: 'Next connection',
    status: 'running',
    statusText: 'streaming',
    activeRunId: 'run-exact',
    runs: [
      {
        id: 'run-exact',
        status: 'running',
        profileName: 'Exact run profile',
        profileDigest: 'digest-run',
        runner: 'pi',
        model: 'tangle-router/glm-5.2',
        effort: 'high',
        maxVisibleOutputTokens: 16_384,
        maxReasoningTokens: 8_192,
        maxTotalOutputTokens: 24_576,
        connection: 'Local CLI Bridge',
        connectionId: 'connection-run',
        environmentId: 'environment-run',
        usage: { model: 'tangle-router/glm-5.2' },
        completeness: 'streaming',
      },
    ],
    environments: [
      {
        id: 'environment-run',
        connectionId: 'connection-run',
        kind: 'local-process',
        provider: 'cli-bridge',
        lifecycle: 'active',
        location: 'local',
        unavailableTelemetry: [],
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:01.000Z',
      },
    ],
    activity: [
      {
        id: 'activity-run-exact',
        kind: 'run',
        title: 'exact run',
        status: 'running',
        runId: 'run-exact',
      },
    ],
  }

  assert.deepEqual(executionTargetFor(view), {
    source: 'run',
    runId: 'run-exact',
    profileName: 'Exact run profile',
    profileDigest: 'digest-run',
    runner: 'pi',
    model: 'tangle-router/glm-5.2',
    backend: 'cli-bridge',
    effort: 'high',
    maxVisibleOutputTokens: 16_384,
    maxReasoningTokens: 8_192,
    maxTotalOutputTokens: 24_576,
    connection: 'Local CLI Bridge',
    connectionId: 'connection-run',
    environment: view.environments[0],
  })

  const chrome = new TerminalChrome(theme)
  chrome.setState({
    view,
    quitArmed: false,
    activityVisible: true,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })
  const rendered = chrome.render(120).join('\n')
  assert.match(rendered, /Exact run profile/u)
  assert.match(rendered, /pi \/ tangle-router\/glm-5\.2/u)
  assert.match(rendered, /CLI Bridge/u)
  assert.doesNotMatch(rendered, /backend cli-bridge|pi · tangle-router/u)
  assert.doesNotMatch(rendered, /exec local CLI|active/u)
  assert.doesNotMatch(rendered, /Next profile|openai\/gpt-next|Next connection/u)

  const activity = activityDocument(view)
  assert.match(activity.context ?? '', /Exact run profile · pi · tangle-router\/glm-5\.2/u)
  const detail = activity.rows[0]?.detailLines.join('\n') ?? ''
  assert.match(detail, /profile digest: digest-run/u)
  assert.match(detail, /max visible output tokens: 16384/u)

  const { activeRunId: _activeRunId, ...idleView } = view
  const idleTarget = executionTargetFor({ ...idleView, status: 'completed' })
  assert.equal(idleTarget.source, 'profile')
  assert.equal(idleTarget.profileName, 'Next profile')
  assert.equal(idleTarget.model, 'openai/gpt-next')
  assert.equal(idleTarget.environment, undefined)
})

test('the wide rail shows only observed sandbox facts and measured usage', () => {
  const base = usageView()
  const view: BraidViewModel = {
    ...base,
    status: 'running',
    statusText: 'streaming',
    activeRunId: 'sandbox-run',
    runs: [
      {
        id: 'sandbox-run',
        status: 'running',
        completeness: 'streaming',
        profileName: base.profileName,
        runner: base.runner,
        model: base.model,
        effort: 'high',
        maxVisibleOutputTokens: 16_384,
        maxReasoningTokens: 8_192,
        maxTotalOutputTokens: 24_576,
        provider: 'tangle-sandbox',
        connection: 'Tangle Sandbox',
        environmentId: 'sandbox-1',
        usage: { model: base.model },
      },
    ],
    environments: [
      {
        id: 'sandbox-1',
        connectionId: 'sandbox-connection',
        kind: 'sandbox',
        provider: 'tangle-sandbox',
        lifecycle: 'ready',
        location: 'remote',
        runtimeEndpointHost: '10.0.0.7',
        machineId: 'machine-a10',
        verifiedRegion: 'us-central',
        requestedResources: { cpuCores: 2, memoryMB: 4_096, diskGB: 20 },
        resourceSample: {
          cgroupVersion: 2,
          memoryCurrentMb: 512,
          memoryPeakMb: 768,
          cpuUsageUsec: 2_500,
          sampledAt: '2026-08-15T00:00:01.000Z',
        },
        gpu: {
          provider: 'tangle',
          accelerator: 'A10',
          count: 1,
          status: 'allocated',
          billedCustomerCostUsd: 0.0123,
        },
        unavailableTelemetry: ['physical-ip'],
        createdAt: '2026-08-15T00:00:00.000Z',
        updatedAt: '2026-08-15T00:00:01.000Z',
      },
    ],
  }
  const chrome = new TerminalChrome(theme)
  chrome.setState({
    view,
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })

  const rendered = chrome.render(200).join('\n')
  assert.match(rendered, /Sandbox/u)
  assert.doesNotMatch(rendered, /backend tangle-sandbox/u)
  assert.match(rendered, /host 10\.0\.0\.7/u)
  assert.match(rendered, /machine machine-a10/u)
  assert.match(rendered, /region us-central/u)
  assert.match(rendered, /sample mem 512MB/u)
  assert.match(rendered, /requested 2cpu · 4GB · 20GB/u)
  assert.match(rendered, /gpu 1× A10 \$0\.0123/u)
  assert.match(rendered, /high · caps vis 16k · reas 8\.2k · total 25k/u)
  assert.doesNotMatch(rendered, /fixture\/deterministic|thinking none|unknown|not reported/u)
  assert.match(rendered, /in 10|out 20|≥\$0\.0100|latency ≥120ms/u)
  assert.doesNotMatch(rendered, /physical-ip|unknown/u)
  const estimatedGpuView: BraidViewModel = {
    ...view,
    environments: view.environments.map((environment) => ({
      ...environment,
      ...(environment.gpu === undefined
        ? {}
        : (() => {
            const { billedCustomerCostUsd: _billedCustomerCostUsd, ...gpu } = environment.gpu
            return { gpu: { ...gpu, estimatedCustomerCostUsd: 0.42 } }
          })()),
    })),
  }
  chrome.setState({
    view: estimatedGpuView,
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })
  const estimatedGpuFooter = chrome.render(200).join('\n')
  assert.match(estimatedGpuFooter, /gpu 1× A10/u)
  assert.doesNotMatch(estimatedGpuFooter, /\$0\.4200/u)
  chrome.setState({
    view,
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })
  for (const width of [60, 80, 99]) {
    const medium = chrome.render(width).join('\n')
    assert.match(medium, /profile Release engineer/u)
    assert.match(medium, /Ctrl\+C cancel/u)
    if (width >= 80) {
      assert.match(medium, /pi \/ gpt-5\.6-luna/u)
      assert.match(medium, /via Sandbox/u)
    }
    assert.doesNotMatch(
      medium,
      /host |machine |region |sample |requested |gpu |\bin |\bout |\$|latency /u,
    )
    assert.doesNotMatch(medium, /unknown|not reported|…/u)
  }
  for (const width of [40, 60, 80, 99, 100, 120, 160, 200]) {
    for (const line of chrome.render(width)) assert.ok(visibleWidth(line) <= width)
  }
})

function usageView(): BraidViewModel {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const base = createApplicationUiController(app).view()
  return {
    ...base,
    profileName: 'Release engineer',
    runner: 'pi',
    model: 'openai-codex/gpt-5.6-luna',
    effort: 'high',
    maxVisibleOutputTokens: 16_384,
    maxReasoningTokens: 8_192,
    maxTotalOutputTokens: 24_576,
    sessionUsage: {
      turns: {
        sourceCount: 2,
        input: 10,
        output: 20,
        tokenStatus: 'observed-floor',
        costUsd: 0.01,
        costStatus: 'observed-floor',
        llmCalls: 2,
        callStatus: 'partial',
        unknownCallSources: 1,
        llmLatencyMs: 120,
        latencyStatus: 'partial',
        unknownLatencySources: 1,
        unknownTokenSources: 1,
        unknownCostSources: 1,
      },
      analyses: {
        sourceCount: 1,
        input: 0,
        output: 0,
        tokenStatus: 'unknown',
        costStatus: 'unknown',
        callStatus: 'unknown',
        unknownCallSources: 1,
        latencyStatus: 'unknown',
        unknownLatencySources: 1,
        unknownTokenSources: 1,
        unknownCostSources: 1,
      },
      delegated: {
        sourceCount: 1,
        input: 0,
        output: 0,
        tokenStatus: 'complete',
        costUsd: 0,
        costStatus: 'reported',
        llmCalls: 0,
        callStatus: 'complete',
        unknownCallSources: 0,
        llmLatencyMs: 0,
        latencyStatus: 'complete',
        unknownLatencySources: 0,
        unknownTokenSources: 0,
        unknownCostSources: 0,
      },
      attribution: 'separate-totals',
    },
  }
}
