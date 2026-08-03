import assert from 'node:assert/strict'
import test from 'node:test'
import { permissionAnswerSpec, type InteractionRequest } from '@tangle-network/agent-interface'
import {
  InteractionController,
  InteractionError,
} from '../src/controllers/interaction-controller.js'
import {
  answerSpecContainsSecret,
  parseInteractionRequest,
  validateAnswerSpec,
  validateInteractionData,
} from '../src/domain/interaction.js'
import {
  buildAnswerSpecView,
  buildInteractionViews,
  buildPermissionView,
  buildPlanView,
  buildQuestionView,
} from '../src/views/shared/interaction.js'
import {
  keyboardAnswerForView,
  responseForInteractionIntent,
} from '../src/views/shared/interaction-intent.js'
import { FixedClock } from '../src/ports/clock.js'
import { SequenceIds } from '../src/ports/ids.js'
import { DeterministicInteractionRuntime } from '../src/testing/deterministic-interaction-runtime.js'

class TestClock {
  #value: string

  constructor(value = '2026-08-01T00:00:00.000Z') {
    this.#value = value
  }

  now(): string {
    return this.#value
  }

  advance(milliseconds: number): void {
    this.#value = new Date(Date.parse(this.#value) + milliseconds).toISOString()
  }
}

function question(id: string, options: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    id,
    kind: 'question',
    title: 'Choose a value',
    body: 'The answer is required to continue.',
    answerSpec: {
      fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
    },
    ...options,
  }
}

function controller(
  runtime: DeterministicInteractionRuntime,
  clock: { now(): string } = new FixedClock(),
): InteractionController {
  return new InteractionController({ runtime, clock, ids: new SequenceIds() })
}

test('canonical answer specifications render every field and mask secret fields', () => {
  const spec = {
    fields: [
      { type: 'text' as const, name: 'text', label: 'Text', required: true, default: 'hello' },
      { type: 'number' as const, name: 'number', label: 'Number', min: 1, max: 3 },
      { type: 'boolean' as const, name: 'boolean', label: 'Boolean', default: true },
      {
        type: 'select' as const,
        name: 'select',
        label: 'Select',
        options: [{ value: 'a', label: 'A' }],
      },
      { type: 'secret' as const, name: 'token', label: 'Token', required: true },
    ],
  }
  const view = buildAnswerSpecView(spec)
  assert.equal(view.valid, true)
  assert.equal(Object.isFrozen(view), true)
  assert.equal(view.containsSecret, true)
  assert.deepEqual(
    view.fields.map((field) => field.type),
    ['text', 'number', 'boolean', 'select', 'secret'],
  )
  const secret = view.fields[4]
  assert.equal(secret?.type, 'secret')
  if (secret?.type === 'secret') {
    assert.equal(secret.masked, true)
    assert.equal('defaultValue' in secret, false)
  }
  assert.equal(answerSpecContainsSecret(spec), true)
  assert.equal(
    validateInteractionData(spec, 'accepted', {
      text: 'hello',
      number: 2,
      boolean: true,
      select: ['a'],
      token: 'CANARY-SECRET',
    }).ok,
    true,
  )
  assert.equal(
    validateInteractionData(spec, 'accepted', {
      text: 'hello',
      number: Number.NaN,
      boolean: true,
      select: ['a'],
      token: 'CANARY-SECRET',
    }).ok,
    false,
  )
  assert.equal(
    validateAnswerSpec({
      fields: [
        { type: 'text', name: 'same', label: 'A' },
        { type: 'text', name: 'same', label: 'B' },
      ],
    }).ok,
    false,
  )
  assert.equal(Object.isFrozen(buildAnswerSpecView({ fields: [{ type: 'unknown' }] })), true)
})

test('SE-04 permission responses cannot select a scope the provider did not offer', async () => {
  const runtime = new DeterministicInteractionRuntime({
    capabilities: {
      kinds: ['question', 'permission', 'plan'],
      answerTypes: ['text', 'number', 'boolean', 'select', 'secret'],
      scopes: ['once'],
      secretAnswers: true,
      concurrentRequests: true,
      replay: true,
      responseIdempotency: true,
    },
  })
  const app = controller(runtime)
  const request = {
    id: 'limited-permission',
    kind: 'permission' as const,
    title: 'Allow once?',
    answerSpec: {
      fields: [
        {
          type: 'select' as const,
          name: 'grant',
          label: 'Decision',
          required: true,
          options: [{ value: 'allow_session', label: 'Allow for this session' }],
        },
      ],
    },
  }
  app.receive({ runId: 'run-limited-permission', request })
  assert.equal(app.views()[0]?.canRespond, false)
  assert.match(app.views()[0]?.capabilityError ?? '', /permission scope/i)
  runtime.registerPending('run-limited-permission', 'limited-permission')
  const result = await app.respond({
    runId: 'run-limited-permission',
    interactionId: 'limited-permission',
    operationId: 'op-limited-permission',
    response: {
      id: 'limited-permission',
      outcome: 'accepted',
      data: { grant: ['allow_session'] },
    },
  })
  assert.equal(result.status, 'invalid')
  assert.equal(runtime.calls.length, 0)
})

test('AN-08/AN-09 keyboard intents cover every canonical answer type and specialized surfaces', () => {
  const runtime = new DeterministicInteractionRuntime()
  const app = controller(runtime)
  const cases = [
    {
      id: 'keyboard-text',
      field: { type: 'text' as const, name: 'value', label: 'Value', required: true },
      raw: 'hello',
      expected: { value: 'hello' },
    },
    {
      id: 'keyboard-number',
      field: { type: 'number' as const, name: 'value', label: 'Value', required: true },
      raw: '2',
      expected: { value: 2 },
    },
    {
      id: 'keyboard-boolean',
      field: { type: 'boolean' as const, name: 'value', label: 'Value', required: true },
      raw: 'yes',
      expected: { value: true },
    },
    {
      id: 'keyboard-select',
      field: {
        type: 'select' as const,
        name: 'value',
        label: 'Value',
        required: true,
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
      raw: 'b',
      expected: { value: ['b'] },
    },
    {
      id: 'keyboard-secret',
      field: { type: 'secret' as const, name: 'value', label: 'Value', required: true },
      raw: 'secret-entry',
      expected: { value: 'secret-entry' },
    },
  ]
  for (const item of cases) {
    const received = app.receive({
      runId: 'run-keyboard',
      request: {
        id: item.id,
        kind: 'question',
        title: item.id,
        answerSpec: { fields: [item.field] },
      },
    })
    const record = app.state().interactions.find((interaction) => interaction.key === received.key)
    assert.ok(record)
    const view = buildQuestionView(record, app.state().interactions, '2026-08-01T00:00:00.000Z')
    assert.deepEqual(
      responseForInteractionIntent(view.interactionId, keyboardAnswerForView(view, item.raw)),
      { id: item.id, outcome: 'accepted', data: item.expected },
    )
  }
  assert.deepEqual(responseForInteractionIntent('decline', { kind: 'decline' }), {
    id: 'decline',
    outcome: 'declined',
  })
  assert.deepEqual(responseForInteractionIntent('cancel', { kind: 'cancel' }), {
    id: 'cancel',
    outcome: 'cancelled',
  })

  app.receive({
    runId: 'run-keyboard',
    request: {
      id: 'keyboard-permission',
      kind: 'permission',
      title: 'Permission',
      answerSpec: permissionAnswerSpec({ allowFeedback: false }),
    },
  })
  app.receive({
    runId: 'run-keyboard',
    request: {
      id: 'keyboard-plan',
      kind: 'plan',
      title: 'Plan',
      answerSpec: { fields: [{ type: 'boolean', name: 'approve', label: 'Approve' }] },
    },
  })
  const permissionRecord = app
    .state()
    .interactions.find((interaction) => interaction.interactionId === 'keyboard-permission')
  const planRecord = app
    .state()
    .interactions.find((interaction) => interaction.interactionId === 'keyboard-plan')
  assert.ok(permissionRecord)
  assert.ok(planRecord)
  assert.equal(
    buildPermissionView(permissionRecord, app.state().interactions, '2026-08-01T00:00:00.000Z')
      .surface,
    'permission',
  )
  assert.equal(
    buildPlanView(planRecord, app.state().interactions, '2026-08-01T00:00:00.000Z').surface,
    'plan',
  )
})

test('SE-03 safe subject previews omit provider input and suppress terminal controls', () => {
  const parsed = parseInteractionRequest({
    id: 'safe-subject',
    kind: 'question',
    title: 'Safe subject',
    subject: {
      type: 'tool',
      toolName: 'run-tool',
      input: { token: 'CANARY-SECRET' },
    },
    answerSpec: { fields: [{ type: 'text', name: 'value', label: 'Value' }] },
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) assert.fail('request should parse')
  assert.equal('input' in (parsed.request.subject ?? {}), false)
  assert.equal(JSON.stringify(parsed.request).includes('CANARY-SECRET'), false)
  const view = buildAnswerSpecView(parsed.request.answerSpec)
  assert.equal(view.valid, true)
})

test('queue is stable FIFO and response binding, stale, replay, and conflict are fail-closed', async () => {
  const runtime = new DeterministicInteractionRuntime()
  const app = controller(runtime)
  const first = app.receive({
    runId: 'run-1',
    providerSessionId: 'session-1',
    request: question('first'),
  })
  const second = app.receive({
    runId: 'run-1',
    providerSessionId: 'session-1',
    request: question('second'),
  })
  runtime.registerPending('run-1', 'first')
  runtime.registerPending('run-1', 'second')

  assert.equal(first.queuePosition, 1)
  assert.equal(second.queuePosition, 2)
  assert.equal(app.state().interactions[0]?.deadlineAt, undefined)
  assert.deepEqual(app.state().queue, ['run-1:first', 'run-1:second'])
  assert.deepEqual(
    buildInteractionViews(app.state(), '2026-08-01T00:00:00.000Z').map(
      (view) => view.queuePosition,
    ),
    [1, 2],
  )

  const stale = await app.respond({
    runId: 'run-1',
    interactionId: 'first',
    providerSessionId: 'wrong-session',
    operationId: 'op-stale',
    response: { id: 'first', outcome: 'accepted', data: { value: 'x' } },
  })
  assert.equal(stale.status, 'stale')
  assert.equal(runtime.calls.length, 0)

  const accepted = await app.respond({
    runId: 'run-1',
    interactionId: 'first',
    providerSessionId: 'session-1',
    operationId: 'op-first',
    response: { id: 'first', outcome: 'accepted', data: { value: 'x' } },
  })
  const replay = await app.respond({
    runId: 'run-1',
    interactionId: 'first',
    providerSessionId: 'session-1',
    operationId: 'op-first',
    response: { id: 'first', outcome: 'accepted', data: { value: 'x' } },
  })
  assert.equal(accepted.status, 'accepted')
  assert.equal(replay.status, 'accepted')
  assert.equal(replay.replayed, true)
  assert.equal(runtime.calls.length, 1)

  const conflict = await app.respond({
    runId: 'run-1',
    interactionId: 'first',
    providerSessionId: 'session-1',
    operationId: 'op-different',
    response: { id: 'first', outcome: 'accepted', data: { value: 'different' } },
  })
  assert.equal(conflict.status, 'conflict')
  assert.equal(runtime.calls.length, 1)
})

test('timeout applies only a safe default, while restart reconciliation never revives a missing request', async () => {
  const clock = new TestClock()
  const runtime = new DeterministicInteractionRuntime()
  const app = controller(runtime, clock)
  app.receive({
    runId: 'run-timeout',
    request: question('default', {
      timeoutMs: 100,
      onTimeout: 'default',
      default: { outcome: 'accepted', data: { value: 'automatic' } },
    }),
  })
  runtime.registerPending('run-timeout', 'default')
  clock.advance(100)
  await app.tick()
  assert.equal(app.state().interactions[0]?.status, 'resolved')
  assert.equal(runtime.calls.length, 1)

  const pendingRuntime = new DeterministicInteractionRuntime()
  const original = controller(pendingRuntime, clock)
  original.receive({ runId: 'run-restart', request: question('pending') })
  pendingRuntime.registerPending('run-restart', 'pending')
  const restored = new InteractionController({
    runtime: pendingRuntime,
    clock,
    ids: new SequenceIds(),
    initialEvents: original.events(),
  })
  await restored.reconcile()
  assert.equal(restored.state().interactions[0]?.status, 'pending')

  const missingRuntime = new DeterministicInteractionRuntime()
  const missing = new InteractionController({
    runtime: missingRuntime,
    clock,
    ids: new SequenceIds(),
    initialEvents: original.events(),
  })
  await missing.reconcile()
  assert.equal(missing.state().interactions[0]?.status, 'unknown')
  assert.equal(missing.views().length, 0)

  const failClock = new TestClock()
  const failRuntime = new DeterministicInteractionRuntime()
  const fail = controller(failRuntime, failClock)
  fail.receive({
    runId: 'run-timeout-fail',
    request: question('fail', { timeoutMs: 100, onTimeout: 'fail' }),
  })
  failRuntime.registerPending('run-timeout-fail', 'fail')
  failClock.advance(100)
  await fail.tick()
  assert.equal(fail.state().interactions[0]?.status, 'declined')
  assert.equal(failRuntime.calls.length, 1)

  const resolvedRuntime = new DeterministicInteractionRuntime()
  const resolved = controller(resolvedRuntime)
  resolved.receive({ runId: 'run-already', request: question('already') })
  resolvedRuntime.resolveExternally('run-already', 'already', 'accepted')
  const already = await resolved.respond({
    runId: 'run-already',
    interactionId: 'already',
    operationId: 'op-already',
    response: { id: 'already', outcome: 'accepted', data: { value: 'x' } },
  })
  assert.equal(already.status, 'already_resolved')
  assert.equal(resolved.state().interactions[0]?.status, 'resolved')
})

test('AN-09 late reconciliation cannot overwrite a response accepted concurrently', async () => {
  const runtime = new DeterministicInteractionRuntime()
  const reconcileProvider = runtime.reconcileInteraction.bind(runtime)
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  runtime.reconcileInteraction = async (input) => {
    await barrier
    return reconcileProvider(input)
  }
  const app = controller(runtime)
  app.receive({ runId: 'run-race', request: question('race') })
  runtime.registerPending('run-race', 'race')
  const reconciliation = app.reconcile()
  const response = await app.respond({
    runId: 'run-race',
    interactionId: 'race',
    operationId: 'op-race',
    response: { id: 'race', outcome: 'accepted', data: { value: 'accepted' } },
  })
  assert.equal(response.status, 'accepted')
  release()
  await reconciliation
  assert.equal(app.state().interactions[0]?.status, 'resolved')
})

test('automation is structured, scope-limited, auditable, revocable, and never accepts secret specifications', async () => {
  const runtime = new DeterministicInteractionRuntime()
  const app = new InteractionController({
    runtime,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    defaultContext: {
      profileDigest: 'profile-1',
      connectionId: 'connection-1',
      workspaceId: 'workspace-1',
      runner: 'pi',
    },
  })
  const pending = app.receive({
    runId: 'run-rule',
    providerSessionId: 'session-rule',
    request: {
      id: 'permission-1',
      kind: 'permission',
      title: 'Allow command?',
      subject: { type: 'command', command: 'git status' },
      answerSpec: permissionAnswerSpec({ allowFeedback: false }),
    },
  })
  runtime.registerPending('run-rule', 'permission-1')
  const rule = app.createAutomationRule({
    operationId: 'op-rule-create',
    interactionKey: pending.key,
    answer: { grant: ['allow_once'] },
    responseScope: 'once',
  })
  assert.equal(rule.matcher.subjectValue, 'git status')
  await app.waitForAutomation()
  assert.equal(app.state().interactions[0]?.status, 'resolved')
  assert.equal(app.state().rules[0]?.uses, 1)
  assert.equal(
    app.state().audits.some((audit) => audit.outcome === 'applied'),
    true,
  )

  const secretRuntime = new DeterministicInteractionRuntime()
  const secretApp = controller(secretRuntime)
  const secret = secretApp.receive({
    runId: 'run-secret',
    request: {
      id: 'secret-1',
      kind: 'question',
      title: 'Credential',
      answerSpec: { fields: [{ type: 'secret', name: 'token', label: 'Token', required: true }] },
    },
  })
  await assert.rejects(
    async () =>
      secretApp.createAutomationRule({
        operationId: 'op-secret-rule',
        interactionKey: secret.key,
        answer: { token: 'CANARY-SECRET' },
        responseScope: 'once',
      }),
    (error: unknown) =>
      error instanceof InteractionError && error.code === 'AUTOMATION_SECRET_FORBIDDEN',
  )
  const serialized = JSON.stringify({ state: secretApp.state(), events: secretApp.events() })
  assert.equal(serialized.includes('CANARY-SECRET'), false)
  assert.equal(secretApp.state().rules.length, 0)

  const audit = app.state().audits
  assert.equal(
    audit.some((entry) => entry.outcome === 'applied' && entry.ruleId === rule.id),
    true,
  )
  assert.equal(
    JSON.stringify({ state: secretApp.state(), events: secretApp.events() }).includes(
      'CANARY-SECRET',
    ),
    false,
  )
  assert.equal(app.disableAutomationRule('op-rule-disable', rule.id), true)
  assert.equal(app.state().rules[0]?.enabled, false)
  assert.equal(app.deleteAutomationRule('op-rule-delete', rule.id), true)
  assert.equal(app.state().rules.length, 0)
})

test('manual secret answers reach the provider once and never enter Braid records or feedback', async () => {
  const runtime = new DeterministicInteractionRuntime()
  const app = controller(runtime)
  const received = app.receive({
    runId: 'run-secret-manual',
    providerSessionId: 'session-secret',
    request: {
      id: 'secret-manual',
      kind: 'question',
      title: 'Credential',
      answerSpec: { fields: [{ type: 'secret', name: 'token', label: 'Token', required: true }] },
    },
  })
  runtime.registerPending('run-secret-manual', 'secret-manual')
  const result = await app.respond({
    runId: 'run-secret-manual',
    interactionId: 'secret-manual',
    providerSessionId: 'session-secret',
    operationId: 'op-secret-manual',
    response: {
      id: 'secret-manual',
      outcome: 'accepted',
      data: { token: 'CANARY-SECRET' },
    },
  })
  assert.equal(received.containsSecret, true)
  assert.equal(result.status, 'accepted')
  const record = app.state().interactions[0]
  assert.equal(record?.resolution?.containsSecret, true)
  assert.equal(record?.resolution?.publicData, undefined)
  assert.equal(record?.resolution?.dataDigest, undefined)
  assert.equal(app.state().feedbackDecisions.length, 0)
  assert.equal(
    JSON.stringify({ state: app.state(), events: app.events() }).includes('CANARY-SECRET'),
    false,
  )
  assert.equal(JSON.stringify(runtime.calls).includes('CANARY-SECRET'), false)
  const restored = new InteractionController({
    runtime: new DeterministicInteractionRuntime(),
    clock: new FixedClock(),
    ids: new SequenceIds(),
    initialEvents: app.events(),
  })
  const replay = await restored.respond({
    runId: 'run-secret-manual',
    interactionId: 'secret-manual',
    providerSessionId: 'session-secret',
    operationId: 'op-secret-manual',
    response: {
      id: 'secret-manual',
      outcome: 'accepted',
      data: { token: 'CANARY-SECRET' },
    },
  })
  assert.equal(replay.status, 'already_resolved')
  assert.equal(JSON.stringify(restored.events()).includes('CANARY-SECRET'), false)
})

test('capability negotiation disables unsupported answers and preserves cancel', async () => {
  const runtime = new DeterministicInteractionRuntime({
    capabilities: {
      kinds: ['question'],
      answerTypes: ['text'],
      scopes: ['once'],
      secretAnswers: false,
      concurrentRequests: false,
      replay: false,
      responseIdempotency: true,
    },
  })
  const app = controller(runtime)
  const first = app.receive({
    runId: 'run-capability',
    request: {
      id: 'secret-capability',
      kind: 'question',
      title: 'Secret',
      answerSpec: { fields: [{ type: 'secret', name: 'token', label: 'Token', required: true }] },
    },
  })
  app.receive({ runId: 'run-capability', request: question('queued-capability') })
  const views = app.views()
  assert.equal(views[0]?.canRespond, false)
  assert.match(views[0]?.capabilityError ?? '', /secret/i)
  assert.equal(views[1]?.canRespond, false)
  assert.match(views[1]?.capabilityError ?? '', /one interaction/i)
  runtime.registerPending('run-capability', 'secret-capability')
  const cancelled = await app.cancel({
    runId: 'run-capability',
    interactionId: 'secret-capability',
    operationId: 'op-capability-cancel',
  })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(first.containsSecret, true)
})

test('automation dry-run, expiry, use limits, scope changes, and equal-priority conflicts fail closed', async () => {
  const clock = new TestClock()
  const runtime = new DeterministicInteractionRuntime()
  const app = new InteractionController({
    runtime,
    clock,
    ids: new SequenceIds(),
    defaultContext: { profileDigest: 'profile-1', workspaceId: 'workspace-1' },
  })
  const request = question('automation-template', {
    subject: { type: 'command', command: 'npm test' },
  })
  const firstRule = app.createAutomationRule({
    operationId: 'op-rule-first',
    request,
    matcher: { interactionKind: 'question', subjectType: 'command', subjectValue: 'npm test' },
    answer: { value: 'safe' },
    responseScope: 'once',
    maximumUses: 1,
  })
  const expiredRule = app.createAutomationRule({
    operationId: 'op-rule-expired',
    request: question('automation-template-expired', {
      subject: { type: 'command', command: 'npm test' },
    }),
    matcher: { interactionKind: 'question', subjectType: 'command', subjectValue: 'npm test' },
    answer: { value: 'expired' },
    responseScope: 'once',
    expiresAt: '2026-07-31T23:59:59.000Z',
    priority: -1,
  })
  assert.equal(expiredRule.enabled, true)
  const first = app.receive({
    runId: 'run-automation-first',
    profileDigest: 'profile-1',
    workspaceId: 'workspace-1',
    request,
  })
  runtime.registerPending('run-automation-first', 'automation-template')
  const dryRun = await app.dryRun({ operationId: 'op-dry-run', key: first.key })
  assert.equal(dryRun.replayed, false)
  await app.waitForAutomation()
  assert.equal(app.state().interactions[0]?.status, 'resolved')
  assert.equal(app.state().rules.find((rule) => rule.id === firstRule.id)?.uses, 1)

  const concurrentRuntime = new DeterministicInteractionRuntime()
  const concurrentApp = controller(concurrentRuntime)
  const concurrentRule = concurrentApp.createAutomationRule({
    operationId: 'op-concurrent-rule',
    request: question('concurrent-template'),
    matcher: { interactionKind: 'question' },
    answer: { value: 'one-use' },
    responseScope: 'once',
    maximumUses: 1,
  })
  concurrentApp.receive({ runId: 'run-concurrent', request: question('first') })
  concurrentApp.receive({ runId: 'run-concurrent', request: question('second') })
  concurrentRuntime.registerPending('run-concurrent', 'first')
  concurrentRuntime.registerPending('run-concurrent', 'second')
  await concurrentApp.waitForAutomation()
  assert.equal(concurrentApp.state().rules.find((rule) => rule.id === concurrentRule.id)?.uses, 1)
  assert.equal(concurrentRuntime.calls.length, 1)
  assert.equal(concurrentApp.state().interactions[1]?.status, 'pending')

  const changed = app.receive({
    runId: 'run-automation-changed',
    profileDigest: 'profile-2',
    workspaceId: 'workspace-1',
    request: question('automation-changed', { subject: { type: 'command', command: 'npm test' } }),
  })
  const changedDryRun = await app.dryRun({ operationId: 'op-dry-run-changed', key: changed.key })
  assert.equal(changedDryRun.eligible, false)

  const conflictRuntime = new DeterministicInteractionRuntime()
  const conflictApp = new InteractionController({
    runtime: conflictRuntime,
    clock,
    ids: new SequenceIds(),
  })
  const conflictRequest = question('conflict-template', {
    subject: { type: 'command', command: 'git diff' },
  })
  conflictApp.createAutomationRule({
    operationId: 'op-conflict-a',
    request: conflictRequest,
    matcher: { interactionKind: 'question', subjectType: 'command', subjectValue: 'git diff' },
    answer: { value: 'a' },
    responseScope: 'once',
  })
  conflictApp.createAutomationRule({
    operationId: 'op-conflict-b',
    request: question('conflict-template-b', { subject: { type: 'command', command: 'git diff' } }),
    matcher: { interactionKind: 'question', subjectType: 'command', subjectValue: 'git diff' },
    answer: { value: 'b' },
    responseScope: 'once',
  })
  conflictApp.receive({ runId: 'run-conflict', request: conflictRequest })
  await conflictApp.waitForAutomation()
  assert.equal(conflictApp.state().interactions[0]?.status, 'pending')
  assert.equal(conflictRuntime.calls.length, 0)
  assert.equal(
    conflictApp.state().audits.some((audit) => audit.outcome === 'conflict'),
    true,
  )
})
