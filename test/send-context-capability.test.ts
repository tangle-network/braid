import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import type { BraidApplication } from '../src/app/application.js'
import { createBraidApplication } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createOperationId } from '../src/domain/ids.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import { FixedClock } from '../src/ports/clock.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecutionPort,
  type RunCapabilities,
} from '../src/ports/execution.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'
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
const NEW_ROUTE = 'Start a new conversation with /new to keep working on this connection.'
const REFUSAL: Readonly<Record<Exclude<Ending, 'completed'>, string>> = {
  failed: `The last run on this branch failed, and this connection continues a branch only after a completed run. ${NEW_ROUTE}`,
  cancelled: `The last run on this branch was cancelled, and this connection continues a branch only after a completed run. ${NEW_ROUTE}`,
  unknown: `The last run on this branch ended without a confirmed result, and this connection continues a branch only after a completed run. ${NEW_ROUTE}`,
}
const GENERIC_REFUSAL = `This connection can't carry this branch's history into a new session. ${NEW_ROUTE}`
const CAPABILITIES: RunCapabilities = {
  ...DEFAULT_RUN_CAPABILITIES,
  sessions: { continue: true, messages: false },
}

type Ending = 'completed' | 'failed' | 'cancelled' | 'unknown'

function connection(id: string, kind: ConnectionRecord['kind']): ConnectionRecord {
  return {
    id: createConnectionId(id),
    kind,
    name: kind === 'tangle-sandbox' ? 'Tangle Sandbox' : 'CLI Bridge',
    providerOptions: { transport: 'local' },
    createdAt: AT,
    updatedAt: AT,
    lastHealth: { status: 'unknown' },
  }
}

const TANGLE = connection('connection-send-tangle', 'tangle-sandbox')
const BRIDGE = connection('connection-send-bridge', 'cli-bridge')

/**
 * Admits like the two real backends: the retained Tangle receipt reports that it cannot carry
 * branch history, and CLI Bridge reports provider-owned context. Each run ends as queued.
 */
function provider(endings: Ending[]) {
  const admitted: string[] = []
  const execution: ExecutionPort = {
    capabilities: () => CAPABILITIES,
    admit: (input) => {
      admitted.push(input.connectionId ?? 'none')
      const bridge = input.connectionId === BRIDGE.id
      return {
        capabilities: CAPABILITIES,
        providerSessionId: `session-${input.connectionId ?? 'none'}`,
        materializationReceipt: {
          provider: bridge ? 'cli-bridge' : 'tangle-sandbox',
          portableContext: bridge ? 'provider-owned' : 'unavailable',
        },
      }
    },
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      const ending = endings.shift() ?? 'completed'
      // A stream that ends without a terminal event leaves the run unknown.
      if (ending === 'unknown') return
      yield {
        type: 'final',
        task: { id: input.runId, intent: input.text },
        status: ending,
        reason: ending,
        text: ending === 'completed' ? `answered: ${input.text}` : '',
        timestamp: AT,
      }
    },
  }
  return { execution, admitted }
}

async function selectConnection(app: BraidApplication, record: ConnectionRecord): Promise<void> {
  await app.configuration.selectConnection({
    connection: record,
    operation: {
      id: createOperationId(`operation-select-${record.id}`),
      kind: 'connection-change',
      requestDigest: canonicalDigest({ command: 'select_connection', connectionId: record.id }),
      status: 'acknowledged',
      target: { kind: 'connection', id: record.id },
      result: { connectionId: record.id },
      createdAt: AT,
      updatedAt: AT,
      acknowledgedAt: AT,
    },
  })
}

async function appAfter(
  ending: Ending,
  options: { readonly journal?: MemoryJournal; readonly endings?: Ending[] } = {},
) {
  const endings: Ending[] = [ending, ...(options.endings ?? [])]
  const fake = provider(endings)
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution: fake.execution,
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  })
  app.initialize('/workspace')
  await selectConnection(app, TANGLE)
  await app.send({ operationId: `operation-first-${ending}`, text: 'first task' }).completion
  assert.equal(app.state().runs.at(-1)?.status, ending)
  return { app, admitted: fake.admitted, controller: createApplicationUiController(app) }
}

function sendCapability(app: BraidApplication) {
  return createApplicationUiController(app).view().capabilities['run.send']
}

function runRequests(app: BraidApplication): number {
  return app.events().filter((entry) => entry.event.kind === 'run.requested').length
}

for (const ending of ['failed', 'unknown', 'cancelled'] as const) {
  test(`a ${ending} retained Tangle tip makes send unavailable with the plain reason`, async () => {
    const { app } = await appAfter(ending)
    try {
      assert.deepEqual(sendCapability(app), {
        available: false,
        source: 'provider',
        reason: REFUSAL[ending],
      })
    } finally {
      await app.close()
    }
  })
}

test('a completed retained Tangle tip keeps send available', async () => {
  const { app } = await appAfter('completed')
  try {
    assert.deepEqual(sendCapability(app), { available: true, source: 'provider' })
  } finally {
    await app.close()
  }
})

test('switching to CLI Bridge after a failed Tangle run makes send available and it runs', async () => {
  const { app, controller, admitted } = await appAfter('failed', { endings: ['completed'] })
  try {
    await selectConnection(app, BRIDGE)
    assert.deepEqual(sendCapability(app), { available: true, source: 'provider' })
    const result = await controller.dispatch({
      type: 'send',
      operationId: 'operation-bridge-send',
      text: 'continue on the bridge',
    })
    assert.equal(result.kind, 'accepted')
    await app.waitForIdle()
    assert.deepEqual(admitted, [TANGLE.id, BRIDGE.id])
    assert.equal(app.state().runs.at(-1)?.status, 'completed')
  } finally {
    await app.close()
  }
})

test('send is available exactly when admission accepts the branch history', async () => {
  const cases: Array<{ ending: Ending; next: ConnectionRecord }> = []
  for (const ending of ['completed', 'failed', 'unknown', 'cancelled'] as const)
    for (const next of [TANGLE, BRIDGE]) cases.push({ ending, next })
  for (const { ending, next } of cases) {
    const label = `${ending} then ${next.kind}`
    const { app, controller, admitted } = await appAfter(ending, { endings: ['completed'] })
    try {
      if (next !== TANGLE) await selectConnection(app, next)
      const capability = controller.view().capabilities['run.send']
      const before = runRequests(app)
      const result = await controller.dispatch({
        type: 'send',
        operationId: `operation-property-${ending}-${next.kind}`,
        text: 'next task',
      })
      if (capability?.available) {
        assert.equal(result.kind, 'accepted', label)
        await app.waitForIdle()
        assert.equal(runRequests(app), before + 1, label)
      } else {
        // The refusal comes from admission itself, with the capability's exact text.
        assert.deepEqual(
          result,
          { kind: 'unavailable', code: 'CONTEXT_TRANSFER_UNAVAILABLE', reason: capability?.reason },
          label,
        )
        assert.equal(runRequests(app), before, label)
        assert.equal(admitted.length, 2, `${label}: admission was asked and refused`)
      }
    } finally {
      await app.close()
    }
  }
})

test('returning to Tangle after a completed CLI Bridge turn is refused with the generic reason', async () => {
  const { app, controller } = await appAfter('failed', { endings: ['completed'] })
  try {
    await selectConnection(app, BRIDGE)
    await controller.dispatch({ type: 'send', operationId: 'operation-bridge', text: 'bridge' })
    await app.waitForIdle()
    await selectConnection(app, TANGLE)
    assert.deepEqual(sendCapability(app), {
      available: false,
      source: 'provider',
      reason: GENERIC_REFUSAL,
    })
  } finally {
    await app.close()
  }
})

test('resubmitting a refused send operation creates no run', async () => {
  const { app, controller } = await appAfter('failed')
  try {
    const before = runRequests(app)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await controller.dispatch({
        type: 'send',
        operationId: 'operation-refused-twice',
        text: 'try again',
      })
      assert.equal(result.kind, 'unavailable')
      await assert.rejects(
        async () => {
          await app.send({ operationId: 'operation-refused-twice', text: 'try again' }).completion
        },
        { code: 'CONTEXT_TRANSFER_UNAVAILABLE', message: REFUSAL.failed },
      )
    }
    assert.equal(runRequests(app), before)
    assert.equal(app.state().runs.length, 1)
  } finally {
    await app.close()
  }
})

test('send stays unavailable after restart', async () => {
  const journal = new MemoryJournal(new FixedClock(AT))
  const { app } = await appAfter('failed', { journal })
  await app.close()
  const restartedJournal = new MemoryJournal(new FixedClock(AT))
  for (const entry of journal.all()) restartedJournal.append(entry)
  const restarted = createBraidApplication({
    fixture: 'deterministic',
    execution: provider([]).execution,
    journal: restartedJournal,
  })
  try {
    restarted.initialize('/workspace')
    await restarted.whenDurable()
    assert.deepEqual(sendCapability(restarted), {
      available: false,
      source: 'provider',
      reason: REFUSAL.failed,
    })
  } finally {
    await restarted.close()
  }
})

test('headless send returns the same plain reason and starts no run', async () => {
  const { app, controller } = await appAfter('failed')
  const responses: BraidResponse[] = []
  const before = runRequests(app)
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
      operationId: 'op-headless-refused',
      command: 'send',
      params: { text: 'continue headless' },
    },
    { version: 1, requestId: 'req-stop', operationId: 'op-headless-stop', command: 'shutdown' },
  ]
  async function* input(): AsyncGenerator<string> {
    yield `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  }
  const code = await runRpc(controller, input(), {
    write: (chunk) => {
      responses.push(JSON.parse(chunk) as BraidResponse)
      return true
    },
  })
  assert.equal(code, 0)
  const refusal = responses.find(
    (response) => response.type === 'error' && response.requestId === 'req-send',
  )
  assert.deepEqual(
    refusal?.type === 'error' ? { code: refusal.code, message: refusal.message } : undefined,
    { code: 'CONTEXT_TRANSFER_UNAVAILABLE', message: REFUSAL.failed },
  )
  const initialized = responses.find(
    (response) => response.type === 'state' && response.requestId === 'req-init',
  )
  assert.ok(initialized?.type === 'state')
  assert.deepEqual(
    (initialized as { view?: { capabilities?: Record<string, unknown> } }).view?.capabilities?.[
      'run.send'
    ],
    { available: false, source: 'provider', reason: REFUSAL.failed },
  )
  assert.equal(runRequests(app), before)
})

for (const [columns, rows] of SIZES) {
  test(`the keyboard keeps the draft and shows the reason at ${columns}x${rows}`, async () => {
    const { app } = await appAfter('failed')
    const terminal = new RecordingTerminal(columns, rows)
    let operation = 0
    const view = new BraidTerminalApp({
      controller: createApplicationUiController(app),
      tui: new TuiMainScreen(terminal),
      theme: createBraidTheme(false),
      workspace: '/workspace',
      nextOperationId: () => `operation-send-unavailable-${++operation}`,
    })
    const done = view.start()
    try {
      const before = runRequests(app)
      await terminal.waitForRender()
      await new Promise((resolve) => setTimeout(resolve, 300))
      terminal.sendInput('retry the task')
      terminal.sendInput('\r')
      const deadline = performance.now() + 3_000
      while (!terminal.getViewport().join('\n').includes('Send unavailable')) {
        if (performance.now() > deadline) throw new Error(terminal.getViewport().join('\n'))
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await app.whenDurable()
      await new Promise((resolve) => setTimeout(resolve, 300))
      await terminal.waitForRender()
      const frame = terminal.getViewport().join('\n')
      assert.match(frame, /Send unavailable/u)
      assert.match(frame.replace(/\s+/gu, ' '), /The last run on this branch failed/u)
      assert.equal(runRequests(app), before)
      assert.equal(app.state().draft, 'retry the task')
      const root = process.env.BRAID_SEND_CAPTURE_ROOT
      if (root) {
        const name = `${columns}x${rows}-send-unavailable`
        await mkdir(root, { recursive: true })
        await writeFile(join(root, `${name}.txt`), `${frame.replace(/[ \t]+$/gmu, '')}\n`)
        await writeFile(
          join(root, `${name}.cast`),
          terminal.cast('After a failed Tangle run, Send explains why and keeps the draft'),
        )
      }
      terminal.sendInput('\u001b')
      await terminal.waitForRender()
      assert.match(terminal.getViewport().join('\n'), /retry the task/u)
    } finally {
      view.stop()
      await done
      await app.close()
    }
  })
}
