import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { runOutcomeDetail, toHeadlessState } from '../src/adapters/tui/ui-projection.js'
import { BraidApplication } from '../src/app/application.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { snapshotFailure } from '../src/app/provider-snapshot.js'
import { providerCause, runtimeFailure } from '../src/app/provider-values.js'
import { providerEventFor, providerMeta } from '../src/app/run-event-mapper.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import { hasProviderCause, MAX_PROVIDER_CAUSE_CHARACTERS } from '../src/domain/provider-values.js'
import type {
  BraidFinalRuntimeEvent,
  BraidRuntimeEvent,
  RuntimeEventEnvelope,
} from '../src/domain/runtime-events.js'
import { FixedClock } from '../src/ports/clock.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'
import { projectSemanticEvent } from '../src/views/shared/semantic-projection.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { RecordingTerminal } from './support/recording-terminal.js'

const AT = '2026-10-15T00:00:00.000Z'
const SIZES = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
] as const
// Credential-shaped test values the shared redactor recognizes. None may reach state, the journal,
// headless output, or a rendered frame.
const CANARIES = [
  'sk-tan-never-persist-this-provider-cause-value',
  'never-persist-this-cause-bearer-value',
  'never-persist-this-cause-assigned-value',
] as const
const PROVIDER_ERROR = `opencode exited after 76 s: Z.ai rejected the request (429 usage window full) for key ${CANARIES[0]}; Authorization: Bearer ${CANARIES[1]}; api_key=${CANARIES[2]}`
const READABLE = 'opencode exited after 76 s: Z.ai rejected the request (429 usage window full)'
const SEAT_REFUSAL = 'Tangle credential command failed (exit 1)'
const REPLAY_CAPABILITIES = {
  ...DEFAULT_RUN_CAPABILITIES,
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, messages: true },
  controls: { cancel: true, steer: false, queue: true, status: true, recreate: true },
  events: { stableIdentity: true, sequence: true, cursor: true },
} as const
const INTENT_ADMISSION = {
  phase: 'environment' as const,
  provider: 'failure-cause-test',
  environmentId: 'environment-failure-cause',
  idempotencyKey: 'environment-failure-cause',
  turnId: 'turn-failure-cause',
  sessionId: 'session-failure-cause',
  executionId: 'execution-failure-cause',
}

function assertNoCanary(label: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const canary of CANARIES)
    assert.equal(text.includes(canary), false, `${label} kept a ${canary.length}-character canary`)
}

function failedFinal(runId: string, text: string): BraidFinalRuntimeEvent {
  return {
    type: 'final',
    task: { id: runId, intent: text },
    status: 'failed',
    reason: 'failed',
    text: '',
    error: { kind: 'backend', message: PROVIDER_ERROR },
    timestamp: AT,
  }
}

/** One run per send; each ends with the provider failure text that carries the canaries. */
function failingApp(journal?: MemoryJournal) {
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      await new Promise((resolve) => setTimeout(resolve, 50))
      yield failedFinal(input.runId, input.text)
    },
  }
  return createBraidApplication({
    fixture: 'deterministic',
    execution,
    ...(journal === undefined ? {} : { journal }),
  })
}

/**
 * The live shape of the quick unknown: Runtime records the retained admission, the model-seat
 * resolver refuses before any Sandbox exists, and the recovery read refuses the same way.
 */
function seatRefusalApp(journal?: MemoryJournal) {
  const refusal = () => new Error(SEAT_REFUSAL)
  const execution: ExecutionPort = {
    streamIdleMs: 1_000,
    statusTimeoutMs: 1_000,
    capabilities: () => REPLAY_CAPABILITIES,
    admit: () => ({
      capabilities: REPLAY_CAPABILITIES,
      providerSessionId: 'session-failure-cause',
    }),
    async *streamTurn(input): AsyncIterable<RuntimeEventEnvelope> {
      await input.onRetainedAdmission?.(INTENT_ADMISSION)
      await new Promise((resolve) => setTimeout(resolve, 50))
      throw refusal()
    },
    // biome-ignore lint/correctness/useYield: the recovery read refuses before any event.
    async *reconnect(): AsyncIterable<RuntimeEventEnvelope> {
      throw refusal()
    },
    status: async () => {
      throw refusal()
    },
  }
  return createBraidApplication({
    fixture: 'deterministic',
    execution,
    ...(journal === undefined ? {} : { journal }),
  })
}

test('a provider cause is redacted before it is bounded and kept on one line', () => {
  assert.equal(providerCause(undefined), undefined)
  assert.equal(providerCause(' \n\t '), undefined)
  const controlled = providerCause('upstream\nrefused\u001b[31m now\u0007') ?? ''
  assert.match(controlled, /^upstream refused /u)
  assert.equal(
    Array.from(controlled).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    }),
    false,
  )
  const cause = providerCause(PROVIDER_ERROR) ?? ''
  assert.ok(cause.startsWith(`${READABLE} for key [redacted`), cause)
  assertNoCanary('cause', cause)
  // A credential that straddles the bound is removed whole before the text is cut.
  const straddling = `${'x'.repeat(MAX_PROVIDER_CAUSE_CHARACTERS - 10)} ${CANARIES[0]}`
  const bounded = providerCause(straddling) ?? ''
  assert.equal(Array.from(bounded).length, MAX_PROVIDER_CAUSE_CHARACTERS)
  assert.ok(bounded.endsWith('…'))
  assert.equal(bounded.includes('sk-tan'), false)
})

test('a thrown runtime failure keeps its code and says why, including wrapped causes', () => {
  assert.deepEqual(runtimeFailure(new Error(SEAT_REFUSAL), 'RUNTIME_EXECUTION_ERROR'), {
    code: 'RUNTIME_EXECUTION_ERROR',
    cause: SEAT_REFUSAL,
    text: SEAT_REFUSAL,
  })
  const wrapped = new Error('retained start failed', { cause: new Error(SEAT_REFUSAL) })
  assert.equal(
    runtimeFailure(wrapped, 'RUNTIME_EXECUTION_ERROR').text,
    `retained start failed: ${SEAT_REFUSAL}`,
  )
  const stopped = Object.assign(new Error('sandbox is gone'), { code: 'SANDBOX_STOPPED' })
  assert.deepEqual(runtimeFailure(stopped, 'RUNTIME_STATUS_ERROR'), {
    code: 'SANDBOX_STOPPED',
    cause: 'sandbox is gone (SANDBOX_STOPPED)',
    text: 'sandbox is gone (SANDBOX_STOPPED)',
  })
  const capacity = Object.assign(new Error('Subscription account capacity is unavailable'), {
    code: 'upstream_unavailable',
    reason: 'busy',
    resetAt: '2026-10-15T10:00:00.000Z',
  })
  assert.equal(
    runtimeFailure(capacity, 'RUNTIME_EXECUTION_ERROR').text,
    'Subscription account capacity is unavailable (upstream_unavailable, busy; resets 2026-10-15T10:00:00.000Z)',
  )
  assert.deepEqual(runtimeFailure({}, 'RUNTIME_EXECUTION_ERROR'), {
    code: 'RUNTIME_EXECUTION_ERROR',
    text: 'RUNTIME_EXECUTION_ERROR',
  })
  assertNoCanary('thrown cause', runtimeFailure(new Error(PROVIDER_ERROR), 'X'))
})

test('streamed and recovered failures prefer a cause over blank, generic, or code-only reasons', () => {
  for (const reason of [
    '',
    ' \n ',
    'failed',
    'failure',
    'error',
    'unknown',
    'blocked',
    'expired',
    'cancelled',
    'canceled',
    'aborted',
    'RUNTIME_STATUS',
    `RUNTIME_${'A'.repeat(MAX_PROVIDER_CAUSE_CHARACTERS + 100)}`,
    CANARIES[0],
    `api_key=${CANARIES[2]}`,
    `Authorization: Bearer ${CANARIES[1]}`,
    `api_key=${CANARIES[2]}; Authorization: Bearer ${CANARIES[1]}`,
    `failed: api_key=${CANARIES[2]}`,
    `RUNTIME_STATUS; api_key=${CANARIES[2]}`,
    `RUNTIME_${'A'.repeat(MAX_PROVIDER_CAUSE_CHARACTERS)}…`,
  ]) {
    const event = { ...failedFinal('run-cause', 'Go.'), reason }
    const mapped = providerEventFor('run-cause', event, providerMeta('final-cause', 1, event, AT))
    assert.equal(mapped.kind, 'run.finished')
    if (mapped.kind !== 'run.finished') throw new Error('Expected a finished run')
    const recovered = snapshotFailure(
      { error: PROVIDER_ERROR, detail: reason },
      'RUNTIME_RECONCILIATION_ERROR',
      'RUNTIME_RECONCILIATION_STATUS',
    )
    assert.ok(mapped.reason?.startsWith(READABLE), JSON.stringify({ reason, mapped }))
    assert.equal(recovered.reason, mapped.reason, JSON.stringify({ reason, recovered }))
    assertNoCanary('streamed and recovered causes', { mapped, recovered })
  }
})

test('cause classification scans long internal punctuation without treating it as an edge', () => {
  const punctuation = ':'.repeat(64 * 1024)
  assert.equal(hasProviderCause(`a${punctuation}b`), true)
  assert.equal(hasProviderCause(`${punctuation}failed${punctuation}`), false)
})

test('an informative terminal reason keeps precedence and outcome-only history stays honest', () => {
  const event = {
    ...failedFinal('run-cause', 'Go.'),
    reason: 'The provider exhausted its retry budget',
  }
  const mapped = providerEventFor('run-cause', event, providerMeta('final-cause', 1, event, AT))
  assert.equal(mapped.kind, 'run.finished')
  if (mapped.kind !== 'run.finished') throw new Error('Expected a finished run')
  assert.equal(mapped.reason, event.reason)
  assert.equal(
    snapshotFailure({ error: PROVIDER_ERROR, detail: event.reason }, 'X', 'Y').reason,
    event.reason,
  )
  assert.deepEqual(snapshotFailure({ detail: 'failed' }, 'X', 'Y'), { reason: 'failed' })
  assert.deepEqual(snapshotFailure({ error: 'SANDBOX_STOPPED' }, 'X', 'Y'), {
    error: 'SANDBOX_STOPPED',
  })
  for (const reason of [
    `The upstream refused key ${CANARIES[0]} after its usage window closed`,
    `The upstream refused: ${'x'.repeat(MAX_PROVIDER_CAUSE_CHARACTERS + 100)}`,
  ]) {
    const withReason = { ...event, reason }
    const finished = providerEventFor(
      'run-cause',
      withReason,
      providerMeta('final-cause', 1, withReason, AT),
    )
    assert.ok(finished.kind === 'run.finished')
    assert.equal(finished.reason, providerCause(reason))
    assert.equal(
      snapshotFailure({ error: PROVIDER_ERROR, detail: reason }, 'X', 'Y').reason,
      providerCause(reason),
    )
  }
})

test('a failed run records its code and readable cause, with the credential redacted everywhere', async () => {
  const journal = new MemoryJournal(new FixedClock())
  const app = failingApp(journal)
  try {
    app.initialize('/workspace')
    const state = await app.send({ operationId: 'operation-cause', text: 'Do the task.' })
      .completion
    const run = state.runs.at(-1)
    assert.equal(run?.status, 'failed')
    assert.equal(run?.error, 'RUNTIME_FINAL_ERROR')
    assert.ok(run?.terminalReason?.startsWith(READABLE), run?.terminalReason)
    const finished = app.events().find((entry) => entry.event.kind === 'run.finished')?.event
    assert.ok(finished?.kind === 'run.finished')
    assert.equal(finished.error, 'RUNTIME_FINAL_ERROR')
    assert.ok(finished.reason?.startsWith(READABLE))
    assert.ok(run !== undefined && runOutcomeDetail(run)?.startsWith(READABLE))
    assertNoCanary('state', state)
    assertNoCanary('journal', journal.all())
    assertNoCanary('semantic events', app.events().map(projectSemanticEvent))
    const headless = toHeadlessState(state)
    const message = headless.messages.find((candidate) => candidate.runId === run.id)
    assert.ok(message?.outcome?.startsWith(READABLE), message?.outcome)
    assertNoCanary('headless state', headless)
    const view = createApplicationUiController(app).view()
    assert.ok(view.messages.at(-1)?.outcome?.startsWith(READABLE))
    assertNoCanary('view', view)
  } finally {
    await app.close()
  }
})

test('headless JSONL carries the failure code and cause and never the credential', async () => {
  const app = failingApp()
  const output: string[] = []
  const lines = [
    {
      version: 1,
      requestId: 'req-init',
      command: 'initialize',
      params: { workspace: '/workspace', subscribe: true },
    },
    {
      version: 1,
      requestId: 'req-send',
      operationId: 'op-headless-cause',
      command: 'send',
      params: { text: 'Do the task.' },
    },
    { version: 1, requestId: 'req-stop', operationId: 'op-headless-stop', command: 'shutdown' },
  ]
  async function* input(): AsyncGenerator<string> {
    yield `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  }
  const code = await runRpc(createApplicationUiController(app), input(), {
    write: (chunk) => {
      output.push(chunk)
      return true
    },
  })
  assert.equal(code, 0)
  const responses = output.map((chunk) => JSON.parse(chunk) as BraidResponse)
  const finished = responses.find(
    (response) => response.type === 'event' && response.event.kind === 'run.finished',
  )
  assert.ok(finished?.type === 'event')
  assert.equal(finished.event.payload.error, 'RUNTIME_FINAL_ERROR')
  assert.ok(String(finished.event.payload.reason).startsWith(READABLE))
  assertNoCanary('JSONL', output.join(''))
})

test('a run whose start and recovery both fail says why instead of RUNTIME_RECONCILIATION_ERROR', async () => {
  const app = seatRefusalApp()
  try {
    app.initialize('/workspace')
    const state = await app.send({ operationId: 'operation-seat', text: 'Use the seat.' })
      .completion
    const run = state.runs.at(-1)
    assert.ok(run !== undefined)
    assert.equal(run.status, 'unknown')
    const unknown = app.events().find((entry) => entry.event.kind === 'run.unknown')?.event
    assert.ok(unknown?.kind === 'run.unknown')
    assert.equal(
      unknown.detail,
      `the run failed: ${SEAT_REFUSAL}; recovery failed the same way`,
      JSON.stringify(app.events().map((entry) => entry.event.kind)),
    )
    assert.equal(state.lastError, unknown.detail)
    assert.equal(runOutcomeDetail(run), unknown.detail)
    assert.equal(JSON.stringify(state).includes('RUNTIME_RECONCILIATION_ERROR'), false)
  } finally {
    await app.close()
  }
})

test('a cause survives restart, and a duplicate provider event adds nothing', async () => {
  const journal = new MemoryJournal(new FixedClock())
  const warning: RuntimeEventEnvelope = {
    runId: '',
    eventId: 'warning-1',
    sequence: 1,
    cursor: 'cursor-1',
    receivedAt: AT,
    event: { type: 'warning', code: 'OPENCODE_ERROR', message: PROVIDER_ERROR } as never,
  }
  const execution: ExecutionPort = {
    capabilities: () => REPLAY_CAPABILITIES,
    admit: () => ({ capabilities: REPLAY_CAPABILITIES, providerSessionId: 'session-duplicate' }),
    async *streamTurn(input): AsyncIterable<RuntimeEventEnvelope> {
      const own = { ...warning, runId: input.runId, eventId: `${input.runId}:warning-1` }
      yield own
      yield own
      yield {
        runId: input.runId,
        eventId: `${input.runId}:final`,
        sequence: 2,
        cursor: 'cursor-2',
        receivedAt: AT,
        event: failedFinal(input.runId, input.text) as RuntimeStreamEvent,
      }
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const state = await app.send({ operationId: 'operation-duplicate', text: 'Go.' }).completion
  await app.close()
  const run = state.runs.at(-1)
  const warnings = state.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.kind === 'warning')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.status, 'OPENCODE_ERROR')
  assert.ok(warnings[0]?.text?.startsWith(READABLE), warnings[0]?.text)
  assert.equal(journal.all().filter((entry) => entry.event.kind === 'run.warning').length, 1)

  const restartedJournal = new MemoryJournal(new FixedClock())
  for (const entry of journal.all()) restartedJournal.append(entry)
  const restarted = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal: restartedJournal,
    effectStorage: restartedJournal,
  })
  try {
    restarted.initialize('/workspace')
    await restarted.whenDurable()
    const replayed = restarted.state().runs.find((candidate) => candidate.id === run?.id)
    assert.ok(run !== undefined && replayed !== undefined)
    assert.equal(replayed.terminalReason, run.terminalReason)
    assert.equal(runOutcomeDetail(replayed), runOutcomeDetail(run))
    assertNoCanary('restarted state', restarted.state())
  } finally {
    await restarted.close()
  }
})

test('journals written before causes were kept say no cause was recorded and name the code', async () => {
  const journal = new MemoryJournal(new FixedClock())
  const failed = failingApp(journal)
  failed.initialize('/workspace')
  await failed.send({ operationId: 'operation-old-failed', text: 'Do the task.' }).completion
  await failed.close()
  const unknownJournal = new MemoryJournal(new FixedClock())
  const unknown = seatRefusalApp(unknownJournal)
  unknown.initialize('/workspace')
  await unknown.send({ operationId: 'operation-old-unknown', text: 'Use the seat.' }).completion
  await unknown.close()

  // Before this change Braid wrote only codes: RUNTIME_FINAL_REASON and RUNTIME_RECONCILIATION_ERROR.
  const legacy = (source: MemoryJournal) => {
    const target = new MemoryJournal(new FixedClock())
    for (const entry of source.all()) target.append(legacyEnvelope(entry))
    return target
  }
  const cases = [
    {
      journal: legacy(journal),
      app: failingApp,
      outcome: 'no cause was recorded (RUNTIME_FINAL_ERROR)',
    },
    {
      journal: legacy(unknownJournal),
      app: seatRefusalApp,
      outcome: 'no cause was recorded (RUNTIME_RECONCILIATION_ERROR)',
    },
  ]
  for (const { journal: old, app: open, outcome } of cases) {
    const restarted = open(old)
    try {
      restarted.initialize('/workspace')
      await restarted.whenDurable()
      const run = restarted.state().runs.at(-1)
      assert.ok(run !== undefined)
      assert.equal(runOutcomeDetail(run), outcome)
      for (const terminalReason of [
        '[redacted credential]',
        'failed: [redacted secret]',
        'RUNTIME_STATUS; [redacted secret]',
        `RUNTIME_${'A'.repeat(MAX_PROVIDER_CAUSE_CHARACTERS)}…`,
      ]) {
        assert.equal(runOutcomeDetail({ ...run, terminalReason }), outcome)
      }
      assert.equal(
        createApplicationUiController(restarted).view().messages.at(-1)?.outcome,
        outcome,
      )
    } finally {
      await restarted.close()
    }
  }
})

function legacyEnvelope(entry: BraidEventEnvelope): BraidEventEnvelope {
  const event = entry.event
  if (event.kind === 'run.finished')
    return { ...entry, event: { ...event, reason: 'RUNTIME_FINAL_REASON' } }
  if (event.kind === 'run.unknown')
    return { ...entry, event: { ...event, detail: 'RUNTIME_RECONCILIATION_ERROR' } }
  return entry
}

const FLOWS = {
  'failed-cause': {
    open: () => failingApp(),
    text: 'Summarize the open pull requests.',
    expect: /failed: opencode exited after 76 s/u,
    title: 'A failed run says why under its reply; the credential in the provider text is redacted',
  },
  'unverified-cause': {
    open: () => seatRefusalApp(),
    text: 'Use the Codex seat.',
    expect: /outcome unverified: the run failed: Tangle credential/u,
    title:
      'A run that never started says the seat resolver refused, not RUNTIME_RECONCILIATION_ERROR',
  },
} as const

for (const [flow, scenario] of Object.entries(FLOWS)) {
  for (const [columns, rows] of SIZES) {
    test(`the transcript shows the ${flow} at ${columns}x${rows} after a real keyboard send`, async () => {
      const app = scenario.open()
      const terminal = new RecordingTerminal(columns, rows)
      let operation = 0
      const view = new BraidTerminalApp({
        controller: createApplicationUiController(app),
        tui: new TuiMainScreen(terminal),
        theme: createBraidTheme(false),
        workspace: '/workspace',
        nextOperationId: () => `operation-${flow}-${++operation}`,
      })
      const done = view.start()
      try {
        await terminal.waitForRender()
        await new Promise((resolve) => setTimeout(resolve, 200))
        for (const character of scenario.text) terminal.sendInput(character)
        terminal.sendInput('\r')
        const deadline = Date.now() + 5_000
        while (!scenario.expect.test(terminal.getViewport().join(' ').replace(/\s+/gu, ' '))) {
          if (Date.now() > deadline) throw new Error(terminal.getViewport().join('\n'))
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        await app.whenDurable()
        await new Promise((resolve) => setTimeout(resolve, 200))
        await terminal.waitForRender()
        const frame = terminal.getViewport().join('\n')
        assert.match(frame.replace(/\s+/gu, ' '), scenario.expect)
        assert.doesNotMatch(frame, /RUNTIME_RECONCILIATION_ERROR/u)
        assertNoCanary('frame', frame)
        const cast = terminal.cast(scenario.title)
        assertNoCanary('recording', cast)
        const root = process.env.BRAID_FAILURE_CAPTURE_ROOT
        if (root) {
          const name = `${columns}x${rows}-${flow}`
          await mkdir(root, { recursive: true })
          await writeFile(join(root, `${name}.txt`), `${frame.replace(/[ \t]+$/gmu, '')}\n`)
          await writeFile(join(root, `${name}.cast`), cast)
        }
      } finally {
        view.stop()
        await done
        await app.close()
      }
    })
  }
}
