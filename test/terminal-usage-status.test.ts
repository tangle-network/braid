import assert from 'node:assert/strict'
import test from 'node:test'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import type { BraidViewModel } from '../src/views/shared/models.js'
import { activityDocument } from '../src/views/tui/activity-browser.js'
import { metricsFor, TerminalChrome } from '../src/views/tui/terminal-chrome.js'
import { createBraidTheme } from '../src/views/tui/theme.js'

const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })

test('terminal usage keeps direct, analysis, and worker measurements separate and honest', () => {
  const view = usageView()
  const metrics = metricsFor(view)

  assert.deepEqual(metrics, [
    'turns in ≥10 · out ≥20 · ≥$0.0100 · calls ≥2 (+1 missing) · model ≥120ms (+1 missing)',
    'analysis usage unknown · cost unknown · calls unknown (1 missing) · model unknown (1 missing)',
    'workers in 0 · out 0 · $0.0000 · calls 0 · model 0ms',
  ])

  const context = activityDocument(view).context ?? ''
  assert.match(context, /turns .*calls ≥2 \(\+1 missing\).*model ≥120ms \(\+1 missing\)/u)
  assert.match(context, /analysis .*calls unknown \(1 missing\).*model unknown \(1 missing\)/u)
  assert.match(context, /workers .*calls 0.*model 0ms/u)
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
  for (const line of narrow) assert.ok(line.length <= 40)
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
