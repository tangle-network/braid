import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import type { BraidViewModel } from '../src/views/shared/models.js'
import { activityDocument } from '../src/views/tui/activity-browser.js'
import { executionTargetFor } from '../src/views/tui/execution-target.js'
import { TerminalChrome } from '../src/views/tui/terminal-chrome.js'
import { metricsFor } from '../src/views/tui/terminal-usage.js'
import { createBraidTheme } from '../src/views/tui/theme.js'

const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })

test('terminal usage keeps direct, analysis, and worker measurements separate and honest', () => {
  const view = usageView()
  const metrics = metricsFor(view)

  assert.deepEqual(metrics, [
    'turns in ≥10 · out ≥20 · ≥$0.0100 · calls ≥2 (+1 missing) · latency ≥120ms (+1 missing)',
    'analysis usage unknown · cost unknown · calls unknown (1 missing) · latency unknown (1 missing)',
    'workers in 0 · out 0 · $0.0000 · calls 0 · latency 0ms',
  ])

  const context = activityDocument(view).context ?? ''
  assert.match(context, /turns .*calls ≥2 \(\+1 missing\).*latency ≥120ms \(\+1 missing\)/u)
  assert.match(context, /analysis .*calls unknown \(1 missing\).*latency unknown \(1 missing\)/u)
  assert.match(context, /workers .*calls 0.*latency 0ms/u)
})

test('terminal chrome keeps telemetry out of narrow layouts', () => {
  const chrome = new TerminalChrome(theme)
  chrome.setState({
    view: usageView(),
    quitArmed: false,
    activityVisible: false,
    navigationHint: 'Ctrl+P commands',
  })

  const narrow = chrome.render(40)
  assert.equal(narrow.length, 3)
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

  assert.match(metricsFor(estimated)[0] ?? '', /~\$0\.1500/u)
  assert.doesNotMatch(metricsFor(estimated)[0] ?? '', /≥\$0\.1000/u)

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
  assert.match(metricsFor(freeEstimate)[0] ?? '', /~\$0\.0000/u)
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
    maxOutputTokens: 4096,
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
        maxOutputTokens: 16_384,
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
    effort: 'high',
    maxOutputTokens: 16_384,
    connection: 'Local CLI Bridge',
    connectionId: 'connection-run',
    environment: view.environments[0],
  })

  const chrome = new TerminalChrome(theme)
  chrome.setState({
    view,
    quitArmed: false,
    activityVisible: true,
    navigationHint: 'Ctrl+P commands',
  })
  const rendered = chrome.render(120).join('\n')
  assert.match(rendered, /AgentProfile Exact run profile/u)
  assert.match(rendered, /runner pi/u)
  assert.match(rendered, /tangle-router\/glm-5\.2/u)
  assert.match(rendered, /Local CLI Bridge/u)
  assert.match(rendered, /exec local CLI · active/u)
  assert.doesNotMatch(rendered, /Next profile|openai\/gpt-next|Next connection/u)

  const activity = activityDocument(view)
  assert.match(activity.context ?? '', /Exact run profile · pi · tangle-router\/glm-5\.2/u)
  const detail = activity.rows[0]?.detailLines.join('\n') ?? ''
  assert.match(detail, /profile digest: digest-run/u)
  assert.match(detail, /max output tokens: 16384/u)

  const { activeRunId: _activeRunId, ...idleView } = view
  const idleTarget = executionTargetFor({ ...idleView, status: 'completed' })
  assert.equal(idleTarget.source, 'profile')
  assert.equal(idleTarget.profileName, 'Next profile')
  assert.equal(idleTarget.model, 'openai/gpt-next')
  assert.equal(idleTarget.environment, undefined)
})

function usageView(): BraidViewModel {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const base = createApplicationUiController(app).view()
  return {
    ...base,
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
