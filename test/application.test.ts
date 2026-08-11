import assert from 'node:assert/strict'
import test from 'node:test'
import { type AgentProfile, defineAgentProfile } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { canonicalAgentProfileDigestHex } from '../src/adapters/agent-interface/profile-runtime.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createUiSubscriberDelivery } from '../src/adapters/tui/ui-subscriber-delivery.js'
import { AppError, BraidApplication } from '../src/app/application.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { effectRequestDigest } from '../src/app/effect-coordinator.js'
import { MemoryJournal } from '../src/app/journal.js'
import { createProfileRecord } from '../src/app/profiles.js'
import { runEffectRequest } from '../src/app/run-admission.js'
import { buildAppView } from '../src/app/view-model.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import { createConnectionId } from '../src/domain/ids.js'
import { FixedClock } from '../src/ports/clock.js'
import type { JournalPort } from '../src/ports/effect-storage.js'
import type {
  ControlAcknowledgement,
  ExecutionAdmission,
  ExecutionPort,
} from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'
import { deterministicBackend } from '../src/testing/deterministic-backend.js'
import { MAX_RENDERED_TEXT_CHARS } from '../src/views/shared/sanitize.js'

function deferred<T = void>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function waitUntil(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

test('one send streams through runtime and reaches one terminal result', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')

  const receipt = app.send({ operationId: 'op-1', text: 'hello Braid' })
  const state = await receipt.completion

  assert.equal(state.activeRunId, null)
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[0]?.text, 'hello Braid')
  assert.equal(state.messages[1]?.text, 'Fixture response through pi: hello Braid')
  assert.deepEqual(
    app.events().map((envelope) => envelope.event.kind),
    [
      'workspace.opened',
      'draft.changed',
      'run.requested',
      'effect.upserted',
      'run.provider.event',
      'run.usage',
      'run.artifact',
      'run.finished',
      'effect.upserted',
    ],
  )
})

test('admission snapshots profile and connection before a blocked dispatch', async () => {
  const profileA = defineAgentProfile({
    name: 'old profile',
    harness: 'pi',
    model: { default: 'fixture/old' },
  })
  const profileB = defineAgentProfile({
    name: 'new profile',
    harness: 'pi',
    model: { default: 'fixture/new' },
  })
  const sourceA = createProfileRecord(
    {
      kind: 'inline',
      reference: 'race:old',
      label: 'old profile',
      writable: false,
      trusted: true,
    },
    profileA,
  )
  const sourceB = createProfileRecord(
    {
      kind: 'inline',
      reference: 'race:new',
      label: 'new profile',
      writable: false,
      trusted: true,
    },
    profileB,
  )
  const connection = (name: string): ConnectionRecord => ({
    id: createConnectionId(`connection-race-${name}`),
    kind: 'cli-bridge',
    name,
    providerOptions: { transport: 'local' },
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    lastHealth: { status: 'unknown' },
  })
  const connectionA = connection('old-connection')
  const connectionB = connection('new-connection')
  const dispatches: Array<{
    readonly input: Parameters<NonNullable<ExecutionPort['streamTurn']>>[0]
    readonly release: () => void
  }> = []
  const starts = [deferred(), deferred()]
  const execution: ExecutionPort = {
    admit: () => ({}),
    async *streamTurn(input) {
      const gate = deferred()
      const index = dispatches.length
      dispatches.push({ input, release: () => gate.resolve() })
      starts[index]?.resolve()
      await gate.promise
      yield {
        type: 'final',
        status: 'completed',
        reason: 'race test completed',
        text: `${input.profile.model?.default}:${input.connectionId}`,
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: `race-${index}`, intent: 'admission snapshot' },
        timestamp: '2026-08-03T00:00:00.000Z',
      }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: profileA,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app, {}, undefined, {
    profiles: [sourceA, sourceB],
    connections: [connectionA, connectionB],
  })
  await controller.dispatch({
    type: 'headless-command',
    command: 'select_profile',
    operationId: 'op-select-old-profile',
    params: { ref: sourceA.id },
  })
  await controller.dispatch({
    type: 'headless-command',
    command: 'select_connection',
    operationId: 'op-select-old-connection',
    params: { connectionId: connectionA.id },
  })

  const first = app.send({ operationId: 'op-race-old', text: 'first admitted turn' })
  assert.deepEqual(first.admission.requested.profile, profileA)
  assert.equal(first.admission.requested.connectionId, connectionA.id)
  await starts[0]?.promise

  await controller.dispatch({
    type: 'headless-command',
    command: 'select_profile',
    operationId: 'op-select-new-profile',
    params: { ref: sourceB.id },
  })
  await controller.dispatch({
    type: 'headless-command',
    command: 'select_connection',
    operationId: 'op-select-new-connection',
    params: { connectionId: connectionB.id },
  })
  dispatches[0]?.release()
  await first.completion

  const second = app.send({ operationId: 'op-race-new', text: 'second admitted turn' })
  assert.deepEqual(second.admission.requested.profile, profileB)
  assert.equal(second.admission.requested.connectionId, connectionB.id)
  await starts[1]?.promise
  dispatches[1]?.release()
  await second.completion

  assert.equal(dispatches.length, 2)
  assert.deepEqual(dispatches[0]?.input.profile, first.admission.requested.profile)
  assert.equal(dispatches[0]?.input.connectionId, first.admission.requested.connectionId)
  assert.deepEqual(dispatches[1]?.input.profile, second.admission.requested.profile)
  assert.equal(dispatches[1]?.input.connectionId, second.admission.requested.connectionId)
  assert.equal(first.admission.profileDigest, canonicalAgentProfileDigestHex(profileA))
  assert.equal(second.admission.profileDigest, canonicalAgentProfileDigestHex(profileB))

  for (const receipt of [first, second]) {
    const requested = app
      .events()
      .find((entry) => entry.event.kind === 'run.requested' && entry.event.runId === receipt.runId)
    assert.ok(requested)
    if (requested.event.kind !== 'run.requested') throw new Error('run request disappeared')
    const request = runEffectRequest({
      operationId: receipt.operationId,
      text: receipt.admission.requested.text,
      conversationId: receipt.admission.conversationId,
      branchId: receipt.admission.branchId,
      profile: receipt.admission.requested.profile,
      ...(receipt.admission.requested.connectionId === undefined
        ? {}
        : { connectionId: receipt.admission.requested.connectionId }),
    })
    assert.match(requested.event.requestDigest ?? '', /^[0-9a-f]{64}$/u)
    assert.notEqual(
      requested.event.requestDigest,
      effectRequestDigest({ effectKind: 'run.execute', request }),
    )
  }
})

test('post-startup profile and connection selection reaches the next real resolver run', async () => {
  const profileA = defineAgentProfile({
    name: 'resolver old profile',
    harness: 'pi',
    model: { default: 'fixture/resolver-old' },
  })
  const profileB = defineAgentProfile({
    name: 'resolver selected profile',
    harness: 'pi',
    model: { default: 'fixture/resolver-selected' },
  })
  const sourceB = createProfileRecord(
    {
      kind: 'inline',
      reference: 'resolver:selected',
      label: 'resolver selected profile',
      writable: false,
      trusted: true,
    },
    profileB,
  )
  const connectionB: ConnectionRecord = {
    id: createConnectionId('connection-resolver-selected'),
    kind: 'cli-bridge',
    name: 'resolver selected connection',
    providerOptions: { transport: 'local' },
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    lastHealth: { status: 'unknown' },
  }
  const resolved: Array<{
    readonly profile: Readonly<AgentProfile>
    readonly connectionId?: string
  }> = []
  const journal = new MemoryJournal(new FixedClock())
  const app = createBraidApplication({
    profile: profileA,
    backendResolver: (input) => {
      resolved.push({
        profile: structuredClone(input.profile),
        ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      })
      return deterministicBackend(input)
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app, {}, undefined, {
    profiles: [sourceB],
    connections: [connectionB],
  })
  await controller.dispatch({
    type: 'headless-command',
    command: 'select_profile',
    operationId: 'op-resolver-select-profile',
    params: { ref: sourceB.id },
  })
  await controller.dispatch({
    type: 'headless-command',
    command: 'select_connection',
    operationId: 'op-resolver-select-connection',
    params: { connectionId: connectionB.id },
  })

  const receipt = app.send({ operationId: 'op-resolver-selected-run', text: 'resolver selection' })
  await receipt.completion

  assert.equal(resolved.length, 1)
  assert.deepEqual(resolved[0]?.profile, profileB)
  assert.equal(resolved[0]?.connectionId, connectionB.id)
  assert.match(app.state().messages.at(-1)?.text ?? '', /resolver selection/u)
})

test('restart keeps exact loaded metadata for the matching durable profile', async () => {
  const exactProfile = defineAgentProfile({
    name: 'restart metadata profile',
    harness: 'pi',
    model: {
      default: 'openai/gpt-5.6-luna',
      metadata: { maxTokens: 8192, route: 'private-runtime-choice' },
    },
  })
  const source = createProfileRecord(
    {
      kind: 'inline',
      reference: 'restart:metadata',
      label: 'restart metadata profile',
      writable: false,
      trusted: true,
    },
    exactProfile,
  )
  const journal = new MemoryJournal(new FixedClock())
  const ids = new SequenceIds()
  const executionProfiles: Readonly<AgentProfile>[] = []
  const execution: ExecutionPort = {
    async *streamTurn(input) {
      executionProfiles.push(input.profile)
      yield {
        type: 'final',
        status: 'completed',
        reason: 'restart profile test completed',
        text: 'done',
        task: { id: 'restart-profile', intent: 'restart profile identity' },
        timestamp: '2026-08-03T00:00:00.000Z',
      }
    },
  }
  const first = new BraidApplication({
    profile: exactProfile,
    execution,
    clock: new FixedClock(),
    ids,
    journal,
    effectStorage: journal,
  })
  first.initialize('/workspace')
  const controller = createApplicationUiController(first, {}, undefined, { profiles: [source] })
  await controller.dispatch({
    type: 'headless-command',
    command: 'select_profile',
    operationId: 'op-select-restart-metadata',
    params: { ref: source.id },
  })
  assert.equal(JSON.stringify(first.state()).includes('private-runtime-choice'), false)
  assert.deepEqual(first.state().profile.model?.metadata, {
    maxTokens: 8192,
    redacted: '[redacted]',
  })
  const durableProfileSelection = JSON.stringify(journal.all())
  assert.equal(durableProfileSelection.includes('private-runtime-choice'), false)
  assert.equal(durableProfileSelection.includes(canonicalAgentProfileDigestHex(exactProfile)), true)

  const restarted = new BraidApplication({
    profile: exactProfile,
    execution,
    clock: new FixedClock(),
    ids,
    journal,
    effectStorage: journal,
  })
  await restarted.send({ operationId: 'op-after-profile-restart', text: 'continue' }).completion

  assert.deepEqual(executionProfiles[0]?.model?.metadata, {
    maxTokens: 8192,
    route: 'private-runtime-choice',
  })

  const mismatchedProfile = defineAgentProfile({
    name: exactProfile.name,
    harness: exactProfile.harness,
    model: {
      default: exactProfile.model?.default ?? 'openai/gpt-5.6-luna',
      metadata: { maxTokens: 4096, route: 'different-private-runtime-choice' },
    },
  })
  const mismatchedRestart = new BraidApplication({
    profile: mismatchedProfile,
    execution,
    clock: new FixedClock(),
    ids,
    journal,
    effectStorage: journal,
  })
  await mismatchedRestart.send({
    operationId: 'op-after-mismatched-profile-restart',
    text: 'continue safely',
  }).completion

  assert.equal(
    JSON.stringify(executionProfiles[1]).includes('different-private-runtime-choice'),
    false,
  )
  assert.deepEqual(executionProfiles[1]?.model?.metadata, {
    maxTokens: 8192,
    redacted: '[redacted]',
  })
  assert.equal(
    mismatchedRestart.state().profiles[0]?.executionDigest,
    canonicalAgentProfileDigestHex(exactProfile),
  )

  const legacyState = {
    ...first.state(),
    profiles: first
      .state()
      .profiles.map(({ executionDigest: _executionDigest, ...profile }) =>
        structuredClone(profile),
      ),
  }
  const legacyBacking = new MemoryJournal(new FixedClock())
  const legacyJournal = {
    initialState: () => structuredClone(legacyState),
    all: () => legacyBacking.all(),
    envelope: (...args: Parameters<MemoryJournal['envelope']>) => legacyBacking.envelope(...args),
    append: (...args: Parameters<MemoryJournal['append']>) => legacyBacking.append(...args),
  }
  const legacyRestart = new BraidApplication({
    profile: exactProfile,
    execution,
    clock: new FixedClock(),
    ids,
    journal: legacyJournal,
    effectStorage: legacyBacking,
  })
  await legacyRestart.send({
    operationId: 'op-after-legacy-profile-snapshot',
    text: 'continue from legacy snapshot safely',
  }).completion

  assert.equal(JSON.stringify(executionProfiles[2]).includes('private-runtime-choice'), false)
  assert.deepEqual(executionProfiles[2]?.model?.metadata, {
    maxTokens: 8192,
    redacted: '[redacted]',
  })
})

test('an identical operation is replayed and conflicting input is rejected', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const first = app.send({ operationId: 'op-stable', text: 'same input' })
  await first.completion
  const eventCount = app.events().length

  const replay = app.send({ operationId: 'op-stable', text: 'same input' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.runId, first.runId)
  await replay.completion
  assert.equal(app.events().length, eventCount)

  await app.send({ operationId: 'op-second', text: 'later input' }).completion
  const currentRevision = app.state().revision
  const lateReplay = app.send({ operationId: 'op-stable', text: 'same input' })
  const replayedState = await lateReplay.completion
  assert.equal(replayedState.revision, currentRevision)
  assert.equal(replayedState.messages.length, 4)
  const finalEventCount = app.events().length

  assert.throws(
    () => app.send({ operationId: 'op-stable', text: 'changed input' }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_CONFLICT',
  )
  assert.equal(app.events().length, finalEventCount + 1)
  assert.equal(app.events().at(-1)?.event.kind, 'effect.upserted')
})

test('async admission reserves one run before the provider becomes visible', async () => {
  const admission = deferred<ExecutionAdmission>()
  const streaming = deferred()
  let admissionCalls = 0
  let streamCalls = 0
  const execution: ExecutionPort = {
    admissionMode: 'async',
    async admit() {
      admissionCalls += 1
      return admission.promise
    },
    async *streamTurn(input) {
      streamCalls += 1
      await streaming.promise
      yield {
        type: 'final',
        status: 'completed',
        reason: 'concurrent admission regression completed',
        text: 'one provider run',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: input.runId, intent: 'reserve admission' },
        timestamp: '2026-08-03T00:00:00.000Z',
      }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')

  const first = app.send({ operationId: 'op-pending', text: 'send once' })
  const replay = app.send({ operationId: 'op-pending', text: 'send once' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.runId, first.runId)
  assert.throws(
    () => app.send({ operationId: 'op-conflict', text: 'second provider request' }),
    (error: unknown) => error instanceof AppError && error.code === 'RUN_ACTIVE',
  )
  assert.throws(
    () => app.send({ operationId: 'op-pending', text: 'changed input' }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_CONFLICT',
  )

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(admissionCalls, 1)
  admission.resolve({})
  await first.admissionReady
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(streamCalls, 1)
  assert.throws(
    () => app.send({ operationId: 'op-active', text: 'still too soon' }),
    (error: unknown) => error instanceof AppError && error.code === 'RUN_ACTIVE',
  )

  streaming.resolve()
  const [firstState, replayState] = await Promise.all([first.completion, replay.completion])
  assert.equal(firstState.runs.length, 1)
  assert.equal(replayState.runs.length, 1)
  assert.equal(admissionCalls, 1)
  assert.equal(streamCalls, 1)
  assert.equal(app.storageFailure(), undefined)
})

test('public mutations reject unsafe operation identities before work or journaling', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const eventCount = app.events().length
  const unsafeOperationId = `op-plain-sk-${'a'.repeat(24)}`

  assert.throws(
    () => app.send({ operationId: 'token=do-not-store', text: 'hello' }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_OPERATION_ID',
  )
  assert.throws(
    () => app.queueInput({ operationId: unsafeOperationId, text: 'queue this' }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_OPERATION_ID',
  )
  await assert.rejects(
    app.steer({ operationId: unsafeOperationId, text: 'steer this' }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_OPERATION_ID',
  )
  await assert.rejects(
    app.cancelRun({ operationId: unsafeOperationId }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_OPERATION_ID',
  )
  await assert.rejects(
    app.detachRun({ operationId: unsafeOperationId }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_OPERATION_ID',
  )
  await assert.rejects(
    app.continueNative({ operationId: unsafeOperationId, text: 'continue this' }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_OPERATION_ID',
  )
  assert.throws(
    () => app.send({ operationId: 'op-too-large', text: 'x'.repeat(1024 * 1024 + 1) }),
    (error: unknown) => error instanceof AppError && error.code === 'MESSAGE_TOO_LARGE',
  )
  assert.equal(app.events().length, eventCount)
})

test('the deterministic stream preserves leading and consecutive newlines', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const state = await app.send({ operationId: 'op-lines', text: '\nA\n\nB' }).completion

  assert.equal(state.messages[1]?.text, 'Fixture response through pi: \nA\n\nB')
})

test('cancellation remains distinct from failure', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 25 })
  app.initialize('/workspace')
  const receipt = app.send({ operationId: 'op-cancel', text: 'cancel this turn' })
  await receipt.admissionReady
  assert.equal(app.cancelActive(), true)
  const state = await receipt.completion

  assert.equal(state.runs[0]?.status, 'aborted')
  assert.match(state.runs[0]?.terminalReason ?? '', /abort|cancel/iu)
  assert.equal(state.lastError, null)
  assert.equal(buildAppView(state).status, 'aborted')
})

test('blocked and unconfigured states remain explicit', async () => {
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield {
        type: 'final',
        status: 'blocked',
        reason: 'approval required',
        text: 'waiting',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-blocked', intent: 'blocked test' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
  }
  const blockedJournal = new MemoryJournal(new FixedClock())
  const blocked = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal: blockedJournal,
    effectStorage: blockedJournal,
  })
  blocked.initialize('/workspace')
  const blockedState = await blocked.send({ operationId: 'op-blocked', text: 'wait' }).completion
  assert.equal(buildAppView(blockedState).status, 'blocked')

  const unconfigured = buildAppView(createBraidApplication().state())
  assert.equal(unconfigured.connection, 'not connected')
  assert.equal(unconfigured.model, 'automatic')
})

test('a terminal journal failure never acknowledges the external run', async () => {
  const delegate = new MemoryJournal(new FixedClock())
  let terminalAttempts = 0
  const journal: JournalPort = {
    envelope: (state, event) => delegate.envelope(state, event),
    append: (envelope) => {
      if (envelope.event.kind === 'run.finished') {
        terminalAttempts += 1
        throw new Error('journal commit failed')
      }
      delegate.append(envelope)
    },
    all: () => delegate.all(),
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        yield {
          type: 'final',
          status: 'completed',
          reason: 'completed',
          text: 'externally completed',
          metadata: { tokenUsage: { input: 1, output: 1 } },
          task: { id: 'task-terminal-failure', intent: 'terminal failure' },
          timestamp: '2026-08-01T00:00:00.000Z',
        }
      },
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: delegate,
  })

  app.initialize('/workspace')
  const receipt = app.send({ operationId: 'op-terminal-journal-failure', text: 'hello' })
  const state = await receipt.completion

  assert.equal(terminalAttempts, 2)
  assert.equal(delegate.current('op-terminal-journal-failure')?.status, 'unknown')
  assert.equal(state.runs[0]?.status, 'streaming')
  assert.equal(state.activeRunId, state.runs[0]?.id)
})

test('completion waits for the terminal event and effect projection to flush', async () => {
  const delegate = new MemoryJournal(new FixedClock())
  const flushes: string[] = []
  let terminalQueued = false
  let terminalEffectQueued = false
  const journal: JournalPort = {
    envelope: (state, event) => delegate.envelope(state, event),
    append: (envelope) => {
      delegate.append(envelope)
      if (envelope.event.kind === 'run.finished') terminalQueued = true
      if (
        envelope.event.kind === 'effect.upserted' &&
        envelope.event.effect.status === 'terminal'
      ) {
        terminalEffectQueued = true
      }
    },
    all: () => delegate.all(),
    flush: async () => {
      flushes.push(
        terminalEffectQueued ? 'terminal-effect' : terminalQueued ? 'terminal-event' : 'intent',
      )
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        yield {
          type: 'final',
          status: 'completed',
          reason: 'completed',
          text: 'complete',
          metadata: { tokenUsage: { input: 1, output: 1 } },
          task: { id: 'task-flush-order', intent: 'flush order' },
          timestamp: '2026-08-01T00:00:00.000Z',
        }
      },
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: delegate,
  })

  app.initialize('/workspace')
  await app.send({ operationId: 'op-flush-order', text: 'hello' }).completion

  assert.deepEqual(flushes, ['intent', 'terminal-event', 'terminal-effect'])
})

test('an asynchronous terminal write failure leaves the external outcome unknown', async () => {
  const delegate = new MemoryJournal(new FixedClock())
  let terminalQueued = false
  const journal: JournalPort = {
    envelope: (state, event) => delegate.envelope(state, event),
    append: (envelope) => {
      delegate.append(envelope)
      if (envelope.event.kind === 'run.finished') terminalQueued = true
    },
    all: () => delegate.all(),
    flush: async () => {
      if (terminalQueued) throw new Error('delayed disk failure')
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        yield {
          type: 'final',
          status: 'completed',
          reason: 'completed',
          text: 'externally complete',
          metadata: { tokenUsage: { input: 1, output: 1 } },
          task: { id: 'task-async-terminal-failure', intent: 'async terminal failure' },
          timestamp: '2026-08-01T00:00:00.000Z',
        }
      },
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: delegate,
  })

  app.initialize('/workspace')
  const receipt = app.send({ operationId: 'op-async-terminal-failure', text: 'hello' })
  await assert.rejects(receipt.completion, /delayed disk failure/u)
  assert.equal(delegate.current('op-async-terminal-failure')?.status, 'unknown')
})

test('provider diagnostics and model metadata cannot persist credential material', async () => {
  const canary = 'never-persist-this-value'
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        yield {
          type: 'final',
          status: 'failed',
          reason: 'failed',
          text: '',
          error: {
            kind: 'transport',
            message: `request failed at https://user:${canary}@provider.example/v1`,
          },
          metadata: {
            model: `model-token-${canary}`,
            tokenUsage: { input: Number.POSITIVE_INFINITY, output: -1 },
          },
          task: { id: 'task-redaction', intent: 'redaction' },
          timestamp: '2026-08-01T00:00:00.000Z',
        }
      },
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })

  app.initialize('/workspace')
  const state = await app.send({ operationId: 'op-redaction', text: 'hello' }).completion
  const serialized = JSON.stringify({ state, events: app.events() })
  assert.equal(serialized.includes(canary), false)
  assert.equal(state.runs[0]?.error, 'RUNTIME_FINAL_ERROR')
  assert.equal(state.runs[0]?.model, 'fixture/deterministic')
  assert.equal(state.runs[0]?.inputTokens, 0)
  assert.equal(state.runs[0]?.outputTokens, 0)
})

test('subscriber failures cannot alter a completed run', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.subscribe(() => {
    throw new Error('renderer failed')
  })
  app.initialize('/workspace')

  const state = await app.send({ operationId: 'op-subscriber', text: 'hello' }).completion

  assert.equal(state.runs[0]?.status, 'completed')
})

test('controller event delivery preserves every committed event', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  const controller = createApplicationUiController(app)
  const received: number[] = []
  const unsubscribe = controller.subscribe((_view, event) => {
    if (event !== undefined) received.push(event.sequence)
  })

  app.initialize('/workspace')
  await app.send({ operationId: 'op-ui-events', text: 'deliver every event' }).completion

  assert.deepEqual(
    received,
    app.events().map((event) => event.sequence),
  )
  unsubscribe()
})

test('controller frame delivery combines a burst and reaches the newest revision', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  const controller = createApplicationUiController(app)
  const revisions: number[] = []
  const unsubscribe = controller.subscribe((view) => revisions.push(view.revision), {
    delivery: 'frame',
    frameIntervalMs: 5,
  })

  app.initialize('/workspace')
  await app.send({ operationId: 'op-ui-frame', text: 'combine this burst' }).completion
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.ok(revisions.length > 0)
  assert.ok(revisions.length <= app.events().length)
  assert.equal(revisions.at(-1), app.state().revision)
  unsubscribe()
})

test('unsubscribing cancels a pending frame delivery', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  let deliveries = 0
  const delivery = createUiSubscriberDelivery({
    subscriber: () => {
      deliveries += 1
    },
    options: { delivery: 'frame' },
    currentView: () => controller.view(),
    project: () => controller.view(),
  })

  delivery.push(app.state(), {
    sequence: 1,
    revision: app.state().revision,
    kind: 'run.text.delta',
    payload: {},
  })
  delivery.dispose()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(deliveries, 0)
})

test('application replacement presents the new profile to frame subscribers', async () => {
  const oldApp = createBraidApplication({
    fixture: 'deterministic',
    profile: defineAgentProfile({ name: 'Old profile', harness: 'pi' }),
  })
  const nextApp = createBraidApplication({
    fixture: 'deterministic',
    profile: defineAgentProfile({ name: 'New profile', harness: 'pi' }),
  })
  const controller = createApplicationUiController(oldApp)
  const profiles: string[] = []
  const unsubscribe = controller.subscribe((view) => profiles.push(view.profileName), {
    delivery: 'frame',
  })

  oldApp.initialize('/old-workspace')
  await controller.replaceApplication(nextApp, '/new-workspace')
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(profiles, ['Old profile', 'New profile'])
  unsubscribe()
  const deliveriesAfterUnsubscribe = profiles.length
  await nextApp.send({ operationId: 'op-after-replacement-unsubscribe', text: 'stay silent' })
    .completion
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(profiles.length, deliveriesAfterUnsubscribe)
  await Promise.all([oldApp.close(), nextApp.close()])
})

test('a selected production connection enables terminal sends for non-fixture models', async () => {
  const profile = defineAgentProfile({
    name: 'Production profile',
    harness: 'opencode',
    model: { default: 'provider/production-model' },
  })
  const connection: ConnectionRecord = {
    id: createConnectionId('connection-production-send-capability'),
    kind: 'cli-bridge',
    name: 'Production CLI Bridge',
    endpoint: 'http://127.0.0.1:3344',
    providerOptions: { transport: 'local' },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    lastHealth: { status: 'healthy', checkedAt: '2026-08-09T00:00:00.000Z' },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = createBraidApplication({
    profile,
    backendResolver: deterministicBackend,
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app, {}, undefined, {
    connections: [connection],
  })
  assert.equal(controller.view().capabilities['run.send']?.available, false)
  const selected = await controller.dispatch({
    type: 'headless-command',
    command: 'select_connection',
    operationId: 'operation-select-production-send-capability',
    params: { connectionId: connection.id },
  })
  assert.equal(selected.kind, 'accepted')
  assert.equal(controller.view().capabilities['run.send']?.available, true)
  const sent = await controller.dispatch({
    type: 'send',
    operationId: 'operation-production-send-capability',
    text: 'production send is available',
  })
  assert.equal(sent.kind, 'accepted')
  await controller.waitForIdle()
  assert.equal(controller.view().runs.at(-1)?.status, 'completed')
  await app.close()
})

test('events after the first final result are ignored', async () => {
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        yield {
          type: 'final',
          status: 'completed',
          reason: 'completed',
          text: 'first final',
          metadata: { tokenUsage: { input: 1, output: 1 } },
          task: { id: 'task-first-final', intent: 'first final' },
          timestamp: '2026-08-01T00:00:00.000Z',
        }
        yield {
          type: 'text_delta',
          text: 'must not append',
          task: { id: 'task-first-final', intent: 'first final' },
          timestamp: '2026-08-01T00:00:00.001Z',
        }
      },
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })

  app.initialize('/workspace')
  const state = await app.send({ operationId: 'op-first-final', text: 'hello' }).completion

  assert.equal(state.messages[1]?.text, 'first final')
  assert.equal(app.events().filter((entry) => entry.event.kind === 'run.text.delta').length, 0)
})

test('provider errors and profile values are redacted before state and journal commit', async () => {
  let providerSawRawProfile = false
  const execution: ExecutionPort = {
    async *streamTurn(input): AsyncIterable<RuntimeStreamEvent> {
      providerSawRawProfile = JSON.stringify(input.profile).includes('CANARY-RAW-PROFILE')
      yield* []
      throw new Error(
        'request failed https://user:CANARY-URL@example.com/?token=CANARY-QUERY Bearer CANARY-BEARER',
      )
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: {
      ...DETERMINISTIC_PROFILE,
      metadata: {
        rawProfile: 'CANARY-RAW-PROFILE',
        mcpConfig: { command: 'CANARY-MCP-CONFIG' },
        attestationNonce: 'CANARY-ATTESTATION-NONCE',
        authorization: 'Bearer CANARY-PROFILE-BEARER',
      },
    },
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-redaction-profile', text: 'trigger provider error' }).completion
  assert.equal(providerSawRawProfile, true)
  const serialized = JSON.stringify({ state: app.state(), events: app.events() })
  assert.equal(serialized.includes('CANARY'), false)
  assert.match(serialized, /\[redacted(?: link| bearer)?\]/u)
  assert.equal(app.state().runs[0]?.status, 'failed')
  assert.equal(app.state().lastError?.includes('CANARY'), false)
  const controller = createApplicationUiController(app)
  const surfaces = JSON.stringify({
    state: controller.state(),
    view: controller.view(),
    events: controller.events(),
  })
  assert.equal(surfaces.includes('CANARY'), false)
  assert.equal(controller.view().statusText.includes('CANARY'), false)
})

test('restart persistence does not expose low-entropy raw prompt or public request hash', async () => {
  const secretPrompt = 'password=0427'
  const secretProfile = defineAgentProfile({
    ...DETERMINISTIC_PROFILE,
    metadata: { recoveryCode: '0427' },
  })
  let dispatches = 0
  let deliveredText: string | undefined
  let deliveredProfile: unknown
  const execution: ExecutionPort = {
    async *streamTurn(input): AsyncIterable<RuntimeStreamEvent> {
      dispatches += 1
      deliveredText = input.text
      deliveredProfile = structuredClone(input.profile)
      yield {
        type: 'final',
        status: 'completed',
        reason: 'secret digest boundary test',
        text: 'safe response',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-secret-digest', intent: 'secret digest boundary' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const first = new BraidApplication({
    profile: secretProfile,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  first.initialize('/workspace')
  const send = first.send({ operationId: 'op-secret-digest', text: secretPrompt })
  await send.completion

  assert.equal(deliveredText, secretPrompt)
  assert.deepEqual(deliveredProfile, secretProfile)
  const publicRequestHash = effectRequestDigest({
    effectKind: 'run.execute',
    request: runEffectRequest({
      operationId: send.operationId,
      text: secretPrompt,
      conversationId: first.state().conversationId,
      branchId: first.state().branchId,
      profile: secretProfile,
    }),
  })
  const firstSerialized = JSON.stringify({ state: first.state(), events: first.events() })
  assert.equal(firstSerialized.includes(secretPrompt), false)
  assert.equal(firstSerialized.includes(publicRequestHash), false)

  const restarted = new BraidApplication({
    profile: secretProfile,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  const replay = restarted.send({ operationId: 'op-secret-digest', text: secretPrompt })
  assert.equal(replay.replayed, true)
  await replay.completion
  assert.equal(dispatches, 1)
  const restartedSerialized = JSON.stringify({
    state: restarted.state(),
    events: restarted.events(),
  })
  assert.equal(restartedSerialized.includes(secretPrompt), false)
  assert.equal(restartedSerialized.includes(publicRequestHash), false)
  assert.equal(restartedSerialized.includes('executionProfileDigest'), false)
  assert.equal(restartedSerialized.includes('executionRequestDigest'), false)
})

test('cancel uses the operation ledger and replays after terminal completion', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 25 })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-cancel-ledger', text: 'cancel this turn' })
  await send.admissionReady
  const first = app.cancel({ operationId: 'op-cancel-stable', runId: send.runId })
  const firstState = await first.completion
  assert.equal(firstState.runs[0]?.status, 'aborted')
  assert.equal(
    app.events().filter((entry) => entry.event.kind === 'run.cancel.requested').length,
    1,
  )
  const replay = app.cancel({ operationId: 'op-cancel-stable', runId: send.runId })
  assert.equal(replay.replayed, true)
  assert.equal((await replay.completion).runs[0]?.status, 'aborted')
  assert.equal(
    app.events().filter((entry) => entry.event.kind === 'run.cancel.requested').length,
    1,
  )
  assert.throws(
    () => app.cancel({ operationId: 'op-cancel-stable', runId: 'run-another' }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_CONFLICT',
  )
})

test('cancel resolves unknown when the adapter cannot confirm the provider outcome', async () => {
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      await new Promise<void>(() => {})
      yield { type: 'text_delta', text: 'never emitted' }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 100,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-send-ignores-abort', text: 'wait for unknown' })
  const cancel = app.cancel({ operationId: 'op-cancel-ignores-abort', runId: send.runId })
  const state = await app.waitForIdle()

  assert.equal(state.activeRunId, null)
  assert.equal(state.runs[0]?.status, 'unknown')
  assert.equal((await cancel.completion).runs[0]?.status, 'unknown')
  assert.match(state.lastError ?? '', /could not be confirmed/iu)
})

test('close cancels active work, is idempotent, and blocks late journal writes', async () => {
  const streamStarted = deferred()
  const releaseStream = deferred()
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      streamStarted.resolve()
      await releaseStream.promise
      yield* []
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 25,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-close-barrier', text: 'close while active' })
  await streamStarted.promise

  const closing = app.close()
  assert.strictEqual(closing, app.close())
  await closing

  assert.equal(app.state().runs[0]?.status, 'unknown')
  assert.throws(
    () => app.send({ operationId: 'op-after-close', text: 'must not start' }),
    (error: unknown) => error instanceof AppError && error.code === 'APPLICATION_CLOSING',
  )
  const eventsAfterClose = app.events().length

  releaseStream.resolve()
  await send.completion.catch(() => undefined)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(app.events().length, eventsAfterClose)
})

test('close aborts deferred admission before materialization or journal writes', async () => {
  const admissionStarted = deferred()
  const releaseAdmission = deferred()
  let materialized = 0
  let streamStarts = 0
  const execution: ExecutionPort = {
    admissionMode: 'async',
    capabilities: { cancel: true },
    async admit(input) {
      admissionStarted.resolve()
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(input.signal.reason ?? new Error('admission aborted'))
        if (input.signal.aborted) {
          onAbort()
          return
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
        void releaseAdmission.promise.then(resolve)
      })
      materialized += 1
      return {}
    },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      streamStarts += 1
      yield* []
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 25,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-deferred-close', text: 'do not materialize' })
  await admissionStarted.promise

  const closing = app.close()
  await closing
  const eventsAfterClose = app.events().length
  releaseAdmission.resolve()
  await send.admissionReady?.catch(() => undefined)
  await send.completion.catch(() => undefined)
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(materialized, 0)
  assert.equal(streamStarts, 0)
  assert.equal(app.events().length, eventsAfterClose)
  assert.equal(
    app.events().some((entry) => entry.event.kind === 'run.requested'),
    false,
  )
})

test('provider acknowledgement, not local abort, settles cancellation', async () => {
  let providerCancellationCalls = 0
  let releaseStream: (() => void) | undefined
  let streamStarted!: () => void
  const streamReady = new Promise<void>((resolve) => {
    streamStarted = resolve
  })
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      streamStarted()
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
      yield {
        type: 'final',
        status: 'completed',
        reason: 'provider acknowledged the late result',
        text: 'late provider result',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-late', intent: 'late result' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
    async cancelRun(): Promise<{ readonly status: 'cancelled' }> {
      providerCancellationCalls += 1
      return { status: 'cancelled' }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 5_000,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-provider-cancel', text: 'provider cancellation' })
  await streamReady
  const startedAt = performance.now()
  const cancel = app.cancel({ operationId: 'op-provider-cancel-request', runId: send.runId })
  const state = await cancel.completion

  assert.equal(providerCancellationCalls, 1)
  assert.equal(state.runs[0]?.status, 'aborted')
  assert.equal(state.runs[0]?.terminalReason, 'Cancellation acknowledged by the provider')
  assert.equal(state.lastError, null)
  assert.ok(performance.now() - startedAt < 1_000)

  releaseStream?.()
  await send.completion
})

test('late provider teardown settles the acknowledgement and corrects unknown exactly once', async () => {
  const streamStarted = deferred()
  const reasoningEmitted = deferred()
  const releaseStream = deferred()
  const cancellationStarted = deferred()
  const releaseCancellation = deferred<ControlAcknowledgement>()
  let providerCancellationCalls = 0
  const operationId = 'op-late-cancel-accepted'
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      streamStarted.resolve()
      yield {
        type: 'reasoning_delta',
        text: 'provider is still tearing down',
        task: { id: 'task-late-cancel', intent: 'late cancellation' },
        timestamp: '2026-08-10T00:00:00.000Z',
      }
      reasoningEmitted.resolve()
      await releaseStream.promise
      yield* []
    },
    async cancelRun(input): Promise<ControlAcknowledgement> {
      providerCancellationCalls += 1
      cancellationStarted.resolve()
      return releaseCancellation.promise.then((acknowledgement) => ({
        ...acknowledgement,
        operationId: input.operationId,
      }))
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 5,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-late-cancel-send', text: 'wait for teardown' })
  await streamStarted.promise
  await reasoningEmitted.promise

  const cancelPromise = app.cancelRun({
    operationId,
    runId: send.runId,
    terminalStatus: 'cancelled',
  })
  await cancellationStarted.promise
  const cancel = await cancelPromise
  assert.equal(cancel.acknowledgement.outcome, 'unknown')
  assert.equal((await cancel.completion).runs[0]?.status, 'unknown')
  assert.equal(
    app.state().messages.find((message) => message.role === 'assistant')?.complete,
    false,
  )

  releaseCancellation.resolve({
    operationId,
    outcome: 'accepted',
    detail: 'Provider cancellation acknowledged',
  })
  await waitUntil(
    () => app.state().runs[0]?.status === 'cancelled',
    'late accepted teardown did not correct the run',
  )

  const state = app.state()
  const assistant = state.messages.find((message) => message.role === 'assistant')
  assert.equal(providerCancellationCalls, 1)
  assert.equal(state.runs[0]?.status, 'cancelled')
  assert.equal(state.runs[0]?.complete, true)
  assert.equal(state.runs[0]?.error, undefined)
  assert.equal(assistant?.status, 'cancelled')
  assert.equal(assistant?.complete, true)
  assert.deepEqual(
    assistant?.parts.map((part) => part.status),
    ['cancelled'],
  )
  assert.equal(
    state.effects.find((effect) => effect.operationId === operationId)?.status,
    'acknowledged',
  )

  const corrections = app
    .events()
    .map((entry) => entry.event)
    .filter((event) => event.kind === 'run.reconciled')
  assert.equal(corrections.length, 1)
  const correction = corrections[0]
  if (correction?.kind !== 'run.reconciled') assert.fail('missing cancellation correction')
  assert.equal(correction.correction, 'cancellation-confirmed')
  assert.equal(correction.operationId, operationId)
  assert.equal(
    app.events().filter((entry) => entry.event.kind === 'run.control.acknowledged').length,
    2,
  )

  const eventCount = app.events().length
  const replay = await app.cancelRun({
    operationId,
    runId: send.runId,
    terminalStatus: 'cancelled',
  })
  await replay.completion
  assert.equal(replay.acknowledgement.outcome, 'accepted')
  assert.equal(providerCancellationCalls, 1)
  assert.equal(app.events().length, eventCount)

  releaseStream.resolve()
  await send.completion
  await app.close()
})

test('late rejected and unknown teardown preserve the unknown run without correction', async () => {
  for (const outcome of ['rejected', 'unknown'] as const) {
    const streamStarted = deferred()
    const releaseStream = deferred()
    const cancellationStarted = deferred()
    const releaseCancellation = deferred<ControlAcknowledgement>()
    const operationId = `op-late-cancel-${outcome}`
    let providerCancellationCalls = 0
    const execution: ExecutionPort = {
      capabilities: { cancel: true },
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        streamStarted.resolve()
        await releaseStream.promise
        yield* []
      },
      async cancelRun(input): Promise<ControlAcknowledgement> {
        providerCancellationCalls += 1
        cancellationStarted.resolve()
        return releaseCancellation.promise.then((acknowledgement) => ({
          ...acknowledgement,
          operationId: input.operationId,
        }))
      },
    }
    const journal = new MemoryJournal(new FixedClock())
    const app = new BraidApplication({
      profile: DETERMINISTIC_PROFILE,
      execution,
      clock: new FixedClock(),
      ids: new SequenceIds(),
      journal,
      effectStorage: journal,
      cancelTimeoutMs: 5,
    })
    app.initialize('/workspace')
    const send = app.send({ operationId: `op-send-late-${outcome}`, text: 'unknown teardown' })
    await streamStarted.promise
    const cancelPromise = app.cancelRun({ operationId, runId: send.runId })
    await cancellationStarted.promise
    const cancel = await cancelPromise
    await cancel.completion
    assert.equal(cancel.acknowledgement.outcome, 'unknown')
    assert.equal(app.state().runs[0]?.status, 'unknown')

    releaseCancellation.resolve({
      operationId,
      outcome,
      detail: `provider returned ${outcome}`,
    })
    await waitUntil(
      () =>
        app.state().effects.find((effect) => effect.operationId === operationId)?.status ===
        (outcome === 'rejected' ? 'failed' : 'unknown'),
      `late ${outcome} teardown did not settle its effect`,
    )
    assert.equal(providerCancellationCalls, 1)
    assert.equal(app.state().runs[0]?.status, 'unknown')
    assert.equal(app.events().filter((entry) => entry.event.kind === 'run.reconciled').length, 0)

    const replay = await app.cancelRun({ operationId, runId: send.runId })
    assert.equal(replay.acknowledgement.outcome, outcome)
    assert.equal(providerCancellationCalls, 1)

    releaseStream.resolve()
    await send.completion
    await app.close()
  }
})

test('shutdown cancel accepts a late teardown settlement while the application remains open', async () => {
  const streamStarted = deferred()
  const releaseStream = deferred()
  const cancellationStarted = deferred()
  const releaseCancellation = deferred<ControlAcknowledgement>()
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      streamStarted.resolve()
      await releaseStream.promise
      yield* []
    },
    async cancelRun(input): Promise<ControlAcknowledgement> {
      cancellationStarted.resolve()
      return releaseCancellation.promise.then((acknowledgement) => ({
        ...acknowledgement,
        operationId: input.operationId,
      }))
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 5,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-shutdown-late-send', text: 'shutdown late' })
  await streamStarted.promise

  const shutdown = app.shutdown({ operationId: 'op-shutdown-late', mode: 'cancel' })
  await cancellationStarted.promise
  assert.equal((await shutdown.completion).runs[0]?.status, 'unknown')

  releaseCancellation.resolve({
    operationId: 'op-shutdown-late:cancel',
    outcome: 'accepted',
    detail: 'Provider cancellation acknowledged',
  })
  await waitUntil(
    () => app.state().runs[0]?.status === 'aborted',
    'shutdown late teardown did not settle the run',
  )
  assert.equal(app.events().filter((entry) => entry.event.kind === 'run.reconciled').length, 1)

  releaseStream.resolve()
  await send.completion
  await app.close()
})

test('close drops a late teardown settlement after its bounded deadline', async () => {
  const streamStarted = deferred()
  const releaseStream = deferred()
  const cancellationStarted = deferred()
  const releaseCancellation = deferred<ControlAcknowledgement>()
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      streamStarted.resolve()
      await releaseStream.promise
      yield* []
    },
    async cancelRun(input): Promise<ControlAcknowledgement> {
      cancellationStarted.resolve()
      return releaseCancellation.promise.then((acknowledgement) => ({
        ...acknowledgement,
        operationId: input.operationId,
      }))
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 5,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-close-late-send', text: 'close late' })
  await streamStarted.promise

  const closing = app.close()
  await cancellationStarted.promise
  await closing
  const eventCountAfterClose = app.events().length
  assert.equal(app.state().runs[0]?.status, 'unknown')

  releaseCancellation.resolve({
    operationId: `operation-close-${send.runId}`,
    outcome: 'accepted',
    detail: 'Provider cancellation acknowledged',
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(app.events().length, eventCountAfterClose)
  assert.equal(app.events().filter((entry) => entry.event.kind === 'run.reconciled').length, 0)

  releaseStream.resolve()
  await send.completion.catch(() => undefined)
})

test('a late cancellation acknowledgement corrects a provider failed consequence without a second run.finished', async () => {
  const streamStarted = deferred()
  const reasoningEmitted = deferred()
  const releaseFinal = deferred()
  const cancellationStarted = deferred()
  const releaseCancellation = deferred<ControlAcknowledgement>()
  const operationId = 'op-late-cancel-failed-race'
  let providerCancellationCalls = 0
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      streamStarted.resolve()
      yield {
        type: 'reasoning_delta',
        text: 'cancellation race',
        task: { id: 'task-failed-race', intent: 'cancellation race' },
        timestamp: '2026-08-10T00:00:00.000Z',
      }
      reasoningEmitted.resolve()
      await releaseFinal.promise
      yield {
        type: 'final',
        status: 'failed',
        reason: 'RUNTIME_FINAL_ERROR',
        text: '',
        metadata: { tokenUsage: { input: 16_081, output: 14 } },
        task: { id: 'task-failed-race', intent: 'cancellation race' },
        error: { kind: 'backend', message: 'RUNTIME_FINAL_ERROR' },
        timestamp: '2026-08-10T00:00:00.000Z',
      }
    },
    async cancelRun(input): Promise<ControlAcknowledgement> {
      providerCancellationCalls += 1
      cancellationStarted.resolve()
      return releaseCancellation.promise.then((acknowledgement) => ({
        ...acknowledgement,
        operationId: input.operationId,
      }))
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 5,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-send-failed-race', text: 'failed cancellation race' })
  await streamStarted.promise
  await reasoningEmitted.promise
  const cancelPromise = app.cancelRun({ operationId, runId: send.runId })
  await cancellationStarted.promise
  releaseFinal.resolve()
  const cancel = await cancelPromise
  const failedState = await cancel.completion
  assert.equal(cancel.acknowledgement.outcome, 'unknown')
  assert.equal(failedState.runs[0]?.status, 'failed')
  assert.equal(failedState.runs[0]?.error, 'RUNTIME_FINAL_ERROR')
  await send.completion

  releaseCancellation.resolve({
    operationId,
    outcome: 'accepted',
    detail: 'Provider cancellation acknowledged',
  })
  await waitUntil(
    () => app.state().runs[0]?.status === 'cancelled',
    'late teardown did not correct the provider failed consequence',
  )
  assert.equal(app.state().runs[0]?.error, undefined)
  assert.equal(
    app.state().messages.find((message) => message.role === 'assistant')?.status,
    'cancelled',
  )
  assert.equal(app.events().filter((entry) => entry.event.kind === 'run.finished').length, 1)
  assert.equal(app.events().filter((entry) => entry.event.kind === 'run.reconciled').length, 1)
  assert.equal(providerCancellationCalls, 1)
  await app.close()
})

test('concurrent cancellation coalesces one provider call and one durable request', async () => {
  const streamStarted = deferred()
  let releaseStream!: () => void
  let providerCancellationCalls = 0
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(input): AsyncIterable<RuntimeStreamEvent> {
      streamStarted.resolve()
      await new Promise<void>((resolve) => {
        releaseStream = resolve
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    async cancelRun(input): Promise<ControlAcknowledgement> {
      providerCancellationCalls += 1
      return { operationId: input.operationId, outcome: 'accepted' }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-concurrent-cancel-send', text: 'cancel once' })
  await streamStarted.promise

  const firstPromise = app.cancelRun({
    operationId: 'op-concurrent-cancel-a',
    runId: send.runId,
    reason: 'cancel concurrently',
  })
  const secondPromise = app.cancelRun({
    operationId: 'op-concurrent-cancel-b',
    runId: send.runId,
    reason: 'cancel concurrently',
  })
  assert.equal(app.canCancel(), false)
  assert.equal(app.cancelActive(), false)

  const [first, second] = await Promise.all([firstPromise, secondPromise])
  await first.completion
  await second.completion
  releaseStream()
  await send.completion

  assert.equal(providerCancellationCalls, 1)
  assert.equal(first.acknowledgement.outcome, 'accepted')
  assert.equal(second.acknowledgement.outcome, 'accepted')
  assert.equal(
    journal.all().filter((entry) => entry.event.kind === 'run.control.requested').length,
    1,
  )
  assert.equal(
    journal.all().filter((entry) => entry.event.kind === 'run.cancel.requested').length,
    1,
  )
  assert.equal(
    journal.all().filter((entry) => entry.event.kind === 'run.control.acknowledged').length,
    1,
  )
})

test('cancel reconciliation accepts only aborted and cancelled provider states', async () => {
  const statuses = ['aborted', 'cancelled', 'completed', 'failed', 'blocked', 'expired'] as const
  for (const providerStatus of statuses) {
    const streamStarted = deferred()
    let releaseStream!: () => void
    let providerCancellationCalls = 0
    let providerStatusCalls = 0
    const execution: ExecutionPort = {
      capabilities: { cancel: true },
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        streamStarted.resolve()
        await new Promise<void>((resolve) => {
          releaseStream = resolve
        })
      },
      async cancelRun(input): Promise<ControlAcknowledgement> {
        providerCancellationCalls += 1
        return {
          operationId: input.operationId,
          outcome: 'unknown',
          detail: 'provider acknowledgement unavailable',
        }
      },
      async status(input) {
        providerStatusCalls += 1
        return { runId: input.runId, status: providerStatus }
      },
    }
    const journal = new MemoryJournal(new FixedClock())
    const app = new BraidApplication({
      profile: DETERMINISTIC_PROFILE,
      execution,
      clock: new FixedClock(),
      ids: new SequenceIds(),
      journal,
      effectStorage: journal,
    })
    app.initialize('/workspace')
    const send = app.send({ operationId: `op-status-${providerStatus}`, text: 'status matrix' })
    await streamStarted.promise
    const input = {
      operationId: `op-cancel-status-${providerStatus}`,
      runId: send.runId,
      reason: 'status matrix cancellation',
    }
    const first = await app.cancelRun(input)
    await first.completion
    const reconciled = await app.cancelRun(input)
    const expected = providerStatus === 'aborted' || providerStatus === 'cancelled'
    assert.equal(reconciled.acknowledgement.outcome, expected ? 'already-applied' : 'unknown')
    assert.equal(providerCancellationCalls, 1)
    assert.equal(providerStatusCalls, 1)

    releaseStream()
    await send.completion
    await app.close()
  }
})

test('a terminal provider event wins a queued cancellation request without dispatch', async () => {
  const clock = new FixedClock()
  const delegate = new MemoryJournal(clock)
  const finalAppendStarted = deferred()
  const releaseFinalAppend = deferred()
  let finalAppendBlocked = false
  let providerCancellationCalls = 0
  const journal: JournalPort & { readonly asynchronous: true } = {
    asynchronous: true,
    envelope: (state, event) => delegate.envelope(state, event),
    append: async (envelope) => {
      if (envelope.event.kind === 'run.finished' && !finalAppendBlocked) {
        finalAppendBlocked = true
        finalAppendStarted.resolve()
        await releaseFinalAppend.promise
      }
      return delegate.append(envelope)
    },
    all: () => delegate.all(),
  }
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    admit: () => ({}),
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield {
        type: 'final',
        status: 'completed',
        reason: 'provider completed before cancellation',
        text: 'completed before cancellation',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-cancel-race', intent: 'cancel race' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
    async cancelRun(input): Promise<ControlAcknowledgement> {
      providerCancellationCalls += 1
      return { operationId: input.operationId, outcome: 'accepted' }
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock,
    ids: new SequenceIds(),
    journal,
    effectStorage: delegate,
  })
  app.initialize('/workspace')
  await app.whenDurable()
  const send = app.send({ operationId: 'op-cancel-race-send', text: 'complete first' })
  await send.admissionReady
  await finalAppendStarted.promise

  assert.equal(app.state().runs[0]?.status, 'streaming')
  const cancelPromise = app.cancelRun({
    operationId: 'op-cancel-race',
    runId: send.runId,
    reason: 'cancel raced with completion',
  })
  await Promise.resolve()
  assert.equal(providerCancellationCalls, 0)

  releaseFinalAppend.resolve()
  const cancel = await cancelPromise
  const state = await cancel.completion
  await send.completion

  assert.equal(providerCancellationCalls, 0)
  assert.equal(cancel.acknowledgement.outcome, 'rejected')
  assert.equal(
    cancel.acknowledgement.detail,
    `Cancellation rejected because run ${send.runId} reached terminal status completed before the request was applied`,
  )
  assert.equal(state.runs[0]?.status, 'completed')
  assert.deepEqual(
    journal
      .all()
      .filter(
        (envelope) =>
          'operationId' in envelope.event && envelope.event.operationId === 'op-cancel-race',
      )
      .map((envelope) => envelope.event.kind),
    ['run.control.requested', 'run.cancel.requested', 'run.control.acknowledged'],
  )

  const next = app.send({ operationId: 'op-cancel-race-next', text: 'storage still works' })
  await next.admissionReady
  await next.completion
  assert.equal(app.state().runs.length, 2)
  await app.close()
})

test('a restarted application replays the journal instead of redispatching', async () => {
  let streamStarts = 0
  let streamStarted!: () => void
  let releaseStream: (() => void) | undefined
  const streamReady = new Promise<void>((resolve) => {
    streamStarted = resolve
  })
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      streamStarts += 1
      streamStarted()
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
      yield {
        type: 'final',
        status: 'completed',
        reason: 'provider acknowledged the restart test',
        text: 'should not be dispatched twice',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-restart', intent: 'restart test' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
    async cancelRun(): Promise<{ readonly status: 'cancelled' }> {
      return { status: 'cancelled' }
    },
  }
  const durable = new MemoryJournal(new FixedClock())
  const first = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal: durable,
    effectStorage: durable,
    cancelTimeoutMs: 100,
  })
  first.initialize('/workspace')
  const send = first.send({ operationId: 'op-durable-send', text: 'restart me' })
  await streamReady

  const restarted = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal: durable,
    effectStorage: durable,
    cancelTimeoutMs: 100,
  })
  assert.equal(restarted.state().runs[0]?.status, 'unknown')
  assert.throws(
    () => restarted.send({ operationId: 'op-durable-send', text: 'restart me' }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'OPERATION_REQUIRES_RECONCILIATION',
  )
  assert.equal(streamStarts, 1)
  assert.equal(restarted.events().filter((entry) => entry.event.kind === 'run.requested').length, 1)

  const shutdown = restarted.shutdown({ operationId: 'op-durable-shutdown' })
  assert.equal(shutdown.replayed, false)
  await shutdown.completion
  const shutdownReplay = restarted.shutdown({ operationId: 'op-durable-shutdown' })
  assert.equal(shutdownReplay.replayed, true)
  await shutdownReplay.completion
  assert.equal(
    restarted.events().filter((entry) => entry.event.kind === 'application.shutdown.requested')
      .length,
    1,
  )

  releaseStream?.()
  await send.completion
})

test('restart reconciles an in-flight cancellation to honest unknown and replays it', async () => {
  const journal = new MemoryJournal(new FixedClock())
  const seeded: readonly BraidEventEnvelope[] = [
    {
      sequence: 1,
      revision: 1,
      occurredAt: '2026-08-01T00:00:00.000Z',
      event: { kind: 'workspace.opened', workspace: '/workspace' },
    },
    {
      sequence: 2,
      revision: 2,
      occurredAt: '2026-08-01T00:00:00.000Z',
      event: {
        kind: 'run.requested',
        operationId: 'op-send-restart',
        runId: 'run-restart',
        turnId: 'turn-restart',
        userMessageId: 'message-user',
        assistantMessageId: 'message-assistant',
        text: 'restart this turn',
      },
    },
    {
      sequence: 3,
      revision: 3,
      occurredAt: '2026-08-01T00:00:00.000Z',
      event: {
        kind: 'run.cancel.requested',
        operationId: 'op-cancel-restart',
        runId: 'run-restart',
        reason: 'user requested cancellation',
      },
    },
  ]
  for (const envelope of seeded) journal.append(envelope)

  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: { streamTurn: async function* () {} },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })

  assert.equal(app.state().runs[0]?.status, 'unknown')
  assert.equal(app.state().messages[1]?.status, 'incomplete')
  const finalEvent = app.events().at(-1)?.event
  assert.equal(finalEvent?.kind, 'run.finished')
  if (finalEvent?.kind !== 'run.finished') assert.fail('missing restart reconciliation event')
  assert.equal(finalEvent.status, 'unknown')
  await app.whenDurable()
  const restoredControl = await app.cancelRun({
    operationId: 'op-cancel-restart',
    runId: 'run-restart',
    reason: 'user requested cancellation',
    legacy: true,
  })
  assert.equal(restoredControl.acknowledgement.outcome, 'unknown')
  assert.equal(
    restoredControl.acknowledgement.detail,
    'Cancellation was requested before the provider acknowledged it',
  )
  const replayed = app.cancel({
    operationId: 'op-cancel-restart',
    runId: 'run-restart',
    reason: 'user requested cancellation',
  })
  assert.equal(replayed.replayed, true)
  assert.equal((await replayed.completion).runs[0]?.status, 'unknown')
})

test('terminal projection preserves complete sanitized response history', async () => {
  const oversized = `stored-history-marker\n${'line\n'.repeat(4_100)}${'x'.repeat(MAX_RENDERED_TEXT_CHARS + 1_024)}`
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      for (let offset = 0; offset < oversized.length; offset += 16_000) {
        yield { type: 'text_delta', text: oversized.slice(offset, offset + 16_000) }
      }
      yield {
        type: 'final',
        status: 'completed',
        reason: 'provider returned the bounded fixture',
        text: '',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-large', intent: 'large output' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-large', text: 'large output' }).completion
  const assistant = createApplicationUiController(app).view().messages.at(-1)
  assert.ok(assistant)
  assert.equal(assistant?.text.length, oversized.length)
  assert.equal(assistant?.text, oversized)
  assert.equal(assistant?.parts[0]?.text, oversized)
  assert.match(assistant?.text ?? '', /^stored-history-marker/u)
  assert.equal(assistant?.parts[0]?.text.includes('\u001b'), false)
})
