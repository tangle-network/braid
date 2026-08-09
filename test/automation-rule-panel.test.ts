import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { InteractionView } from '../src/views/shared/models.js'
import {
  AutomationRulePanel,
  type AutomationRulePanelOptions,
  type AutomationRuleSummary,
} from '../src/views/tui/automation-rule-panel.js'
import { createBraidTheme } from '../src/views/tui/theme.js'

const theme = createBraidTheme(false)

const interaction: InteractionView = {
  runId: 'run-automation-panel',
  interactionId: 'interaction-automation-panel',
  kind: 'question',
  prompt: 'Which answer should be sent?',
  answerSpec: { kind: 'text', required: true, secret: false, maxLength: 64 },
  allowedOutcomes: ['accept', 'once', 'session', 'persistent', 'cancel'],
  responseScopes: ['once', 'session', 'persistent'],
  queuePosition: 0,
  secret: false,
}

const rules: readonly AutomationRuleSummary[] = [
  {
    id: 'rule-first',
    enabled: true,
    responseScope: 'session',
    uses: 1,
    maximumUses: 3,
    matcher: { interactionKind: 'question', subjectType: 'command' },
    answer: { response: 'safe' },
  },
  {
    id: 'rule-disabled',
    enabled: false,
    responseScope: 'once',
    uses: 0,
    matcher: { interactionKind: 'permission' },
    answer: { allow: false },
  },
]

function panel(overrides: Partial<AutomationRulePanelOptions> = {}): AutomationRulePanel {
  return new AutomationRulePanel({
    theme,
    rules: [],
    onCancel: () => {},
    ...overrides,
  })
}

test('creates a typed rule payload after editing a response and choosing a session scope', () => {
  const created: unknown[] = []
  const view = panel({
    interaction,
    onCreate: (intent) => created.push(intent),
  })

  view.handleInput('\u000e')
  view.handleInput('approve this')
  view.handleInput('\r')
  view.handleInput('session')
  view.handleInput('\r')

  assert.deepEqual(created, [
    {
      interaction,
      response: { outcome: 'accept', value: 'approve this' },
      responseScope: 'session',
      confirmPersistent: false,
    },
  ])
})

test('requires a second explicit confirmation before creating a persistent rule', () => {
  const created: unknown[] = []
  const view = panel({
    interaction,
    onCreate: (intent) => created.push(intent),
  })

  view.handleInput('\u000e')
  view.handleInput('save this')
  view.handleInput('\r')
  view.handleInput('persistent')
  view.handleInput('\r')

  assert.deepEqual(created, [])
  assert.match(view.render(80).join('\n'), /save persistent rule\?/u)

  view.handleInput('\r')
  assert.deepEqual(created, [
    {
      interaction,
      response: { outcome: 'accept', value: 'save this' },
      responseScope: 'persistent',
      confirmPersistent: true,
    },
  ])
})

test('secret interactions stay manual and never emit a create intent', () => {
  const created: unknown[] = []
  const secret: InteractionView = {
    ...interaction,
    interactionId: 'interaction-secret-panel',
    answerSpec: { kind: 'secret', required: true },
    secret: true,
  }
  const view = panel({
    interaction: secret,
    onCreate: (intent) => created.push(intent),
  })

  assert.match(view.render(80).join('\n'), /manual only/u)
  view.handleInput('\u000e')
  view.handleInput('never persist this')
  view.handleInput('\r')
  view.handleInput('persistent')
  view.handleInput('\r')

  assert.deepEqual(created, [])
})

test('selects rules and confirms disable and delete intents', () => {
  const selected: string[] = []
  const disabled: string[] = []
  const deleted: string[] = []
  const view = panel({
    rules,
    onSelect: (ruleId) => selected.push(ruleId),
    onDisable: (ruleId) => disabled.push(ruleId),
    onDelete: (ruleId) => deleted.push(ruleId),
  })

  view.handleInput('\u001b[B')
  view.handleInput('\r')
  assert.deepEqual(selected, ['rule-disabled'])

  view.handleInput('\u0001')
  assert.deepEqual(disabled, [])
  view.handleInput('y')
  assert.deepEqual(disabled, ['rule-disabled'])

  view.handleInput('\u0004')
  assert.deepEqual(deleted, [])
  view.handleInput('\u001b')
  assert.deepEqual(deleted, [])
  view.handleInput('\u0004')
  view.handleInput('\r')
  assert.deepEqual(deleted, ['rule-first'])
})

test('Escape cancels the rule list and the editor without producing a payload', () => {
  let cancelled = 0
  const view = panel({
    interaction,
    onCancel: () => {
      cancelled += 1
    },
  })

  view.handleInput('\u001b')
  assert.equal(cancelled, 1)

  const editor = panel({
    interaction,
    onCancel: () => {
      cancelled += 1
    },
  })
  editor.handleInput('\u000e')
  editor.handleInput('\u001b')
  assert.equal(cancelled, 2)
})

test('empty rule management names the product state without offering an unusable action', () => {
  const rendered = panel().render(80).join('\n')

  assert.match(rendered, /No saved automation rules/u)
  assert.match(rendered, /pending request with Alt\+A/u)
  assert.doesNotMatch(rendered, /matching commands|ctrl\+n new/u)
  assert.doesNotMatch(rendered, /^> /mu)
})

test('rule management remains within the reference terminal sizes', () => {
  const view = panel({ rules, interaction })
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const) {
    const lines = view.render(columns)
    assert.ok(lines.length <= rows, `${columns}x${rows} rendered ${lines.length} rows`)
    for (const line of lines) assert.ok(visibleWidth(line) <= columns, line)
  }
})

test('editor preserves a proposed non-secret response until the user changes it', () => {
  const created: unknown[] = []
  const view = panel({
    interaction,
    proposedResponse: { outcome: 'accept', value: 'pre-filled' },
    onCreate: (intent) => created.push(intent),
  })

  view.handleInput('\u000e')
  view.handleInput('\r')
  view.handleInput('\r')

  assert.deepEqual(created, [
    {
      interaction,
      response: { outcome: 'accept', value: 'pre-filled' },
      responseScope: 'once',
      confirmPersistent: false,
    },
  ])
})
