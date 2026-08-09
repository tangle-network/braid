import assert from 'node:assert/strict'
import test from 'node:test'
import { createBraidApplication } from '../src/app/composition.js'
import { effectRequestDigest, SerializedEffectCoordinator } from '../src/app/effect-coordinator.js'
import { MemoryJournal } from '../src/app/journal.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import { FixedClock } from '../src/ports/clock.js'
import type { JournalPort } from '../src/ports/effect-storage.js'

const clock = new FixedClock('2026-08-02T00:00:00.000Z')

function intent(operationId: string, text: string) {
  return { operationId, effectKind: 'test.mutation', request: { text } } as const
}

test('pending intent is durable before dispatch and same input replays one outcome', async () => {
  const storage = new MemoryJournal(clock)
  const coordinator = new SerializedEffectCoordinator(storage, clock)
  const order: string[] = []
  let dispatches = 0

  const first = coordinator.start(intent('op-once', 'same'), {
    dispatch: async (context) => {
      order.push(storage.history(context.operationId)[0]?.status ?? 'missing')
      dispatches += 1
      return { status: 'acknowledged', externalReference: 'external-1' }
    },
  })

  assert.equal(first.record.status, 'pending')
  const acknowledged = await first.completion
  assert.equal(acknowledged.status, 'acknowledged')
  assert.deepEqual(order, ['pending'])
  assert.equal(dispatches, 1)
  assert.deepEqual(
    storage.history('op-once').map((record) => record.status),
    ['pending', 'acknowledged'],
  )

  const replay = coordinator.start(intent('op-once', 'same'), {
    dispatch: async () => {
      throw new Error('replayed effect dispatched')
    },
  })
  assert.equal(replay.replayed, true)
  assert.equal((await replay.completion).status, 'acknowledged')
  assert.equal(dispatches, 1)
})

test('a storage failure prevents external dispatch', async () => {
  const base = new MemoryJournal(clock)
  const storage = {
    reserveEffect: () => {
      throw new Error('disk unavailable')
    },
    current: (operationId: string) => base.current(operationId),
    latest: (operationId: string, requestDigest: string) => base.latest(operationId, requestDigest),
    appendEffect: () => {
      throw new Error('disk unavailable')
    },
    history: (operationId: string) => base.history(operationId),
  }
  const coordinator = new SerializedEffectCoordinator(storage, clock)
  let dispatched = false

  await assert.rejects(
    () =>
      coordinator.execute(intent('op-durable-failure', 'must not dispatch'), {
        dispatch: async () => {
          dispatched = true
          return { status: 'terminal' }
        },
      }),
    { code: 'EFFECT_INTENT_NOT_DURABLE' },
  )
  assert.equal(dispatched, false)
})

test('changed input records a conflict and never dispatches', async () => {
  const storage = new MemoryJournal(clock)
  const coordinator = new SerializedEffectCoordinator(storage, clock)
  let dispatches = 0

  await coordinator.execute(intent('op-conflict', 'first'), {
    dispatch: async () => {
      dispatches += 1
      return { status: 'terminal', detail: 'complete' }
    },
  })
  const conflict = coordinator.start(intent('op-conflict', 'changed'), {
    dispatch: async () => {
      dispatches += 1
      return { status: 'acknowledged' }
    },
  })

  assert.equal(conflict.record.status, 'conflict')
  assert.equal(
    conflict.record.conflictWithDigest,
    effectRequestDigest(intent('op-conflict', 'first')),
  )
  assert.equal((await conflict.completion).status, 'conflict')
  assert.equal(dispatches, 1)
  assert.deepEqual(
    storage.history('op-conflict').map((record) => record.status),
    ['pending', 'terminal', 'conflict'],
  )
})

test('failed, unknown, and terminal dispatch results remain distinct', async () => {
  const storage = new MemoryJournal(clock)
  const coordinator = new SerializedEffectCoordinator(storage, clock)

  const failed = await coordinator.execute(intent('op-failed', 'failed'), {
    dispatch: async () => ({ status: 'failed', detail: 'rejected' }),
  })
  const unknown = await coordinator.execute(intent('op-unknown', 'unknown'), {
    dispatch: async () => {
      throw new Error('connection ended after submit')
    },
  })
  const terminal = await coordinator.execute(intent('op-terminal', 'terminal'), {
    dispatch: async () => ({ status: 'terminal', detail: 'completed' }),
  })

  assert.equal(failed.status, 'failed')
  assert.equal(unknown.status, 'unknown')
  assert.equal(terminal.status, 'terminal')
})

test('provider diagnostics are reduced to safe effect records before persistence', async () => {
  const storage = new MemoryJournal(clock)
  const coordinator = new SerializedEffectCoordinator(storage, clock)

  const result = await coordinator.execute(intent('op-secret-diagnostic', 'safe'), {
    dispatch: async () => ({
      status: 'unknown' as const,
      detail: 'password=do-not-store',
      externalReference: 'token=do-not-store',
    }),
  })

  assert.equal(result.status, 'unknown')
  assert.equal(result.detail, 'EFFECT_UNKNOWN')
  assert.equal(result.externalReference, undefined)
  assert.equal(
    storage
      .history('op-secret-diagnostic')
      .some((entry) => JSON.stringify(entry).includes('do-not-store')),
    false,
  )
})

test('effect metadata rejects credential material before persistence', () => {
  const storage = new MemoryJournal(clock)
  const coordinator = new SerializedEffectCoordinator(storage, clock)

  assert.throws(
    () =>
      coordinator.start(
        {
          ...intent('op-secret-metadata', 'safe'),
          metadata: { token: 'do-not-store' },
        },
        { dispatch: async () => ({ status: 'terminal' }) },
      ),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'EFFECT_METADATA_UNSAFE',
  )
  assert.equal(storage.history('op-secret-metadata').length, 0)
})

test('a state-projection failure after dispatch is recorded as unknown without losing the durable outcome', async () => {
  const storage = new MemoryJournal(clock)
  const recorded: string[] = []
  const coordinator = new SerializedEffectCoordinator(storage, clock, {
    onRecord: (record) => {
      recorded.push(record.status)
      if (record.status === 'terminal') throw new Error('state projection unavailable')
    },
  })

  const result = await coordinator.execute(intent('op-projection-failure', 'accepted externally'), {
    dispatch: async () => ({ status: 'terminal', externalReference: 'external-accepted' }),
  })

  assert.equal(result.status, 'unknown')
  assert.deepEqual(recorded, ['pending', 'terminal', 'unknown'])
  assert.deepEqual(
    storage.history('op-projection-failure').map((record) => record.status),
    ['pending', 'terminal', 'unknown'],
  )
})

test('concurrent effects are serialized and an old pending record is reconciled without guessing', async () => {
  const storage = new MemoryJournal(clock)
  const coordinator = new SerializedEffectCoordinator(storage, clock)
  let active = 0
  let maximumActive = 0

  const dispatch = async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return { status: 'acknowledged' as const }
  }
  const first = coordinator.start(intent('op-a', 'a'), { dispatch })
  const second = coordinator.start(intent('op-b', 'b'), { dispatch })
  await Promise.all([first.completion, second.completion])
  assert.equal(maximumActive, 1)

  const pendingIntent = intent('op-pending', 'pending')
  const digest = effectRequestDigest(pendingIntent)
  storage.appendEffect({
    operationId: pendingIntent.operationId,
    effectKind: pendingIntent.effectKind,
    requestDigest: digest,
    status: 'pending',
    attempt: 1,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    metadata: {},
  })
  let dispatched = false
  const reconciled = coordinator.start(pendingIntent, {
    dispatch: async () => {
      dispatched = true
      return { status: 'terminal' }
    },
    reconcile: async () => ({ status: 'terminal', detail: 'already complete' }),
  })
  assert.equal((await reconciled.completion).status, 'terminal')
  assert.equal(dispatched, false)
})

test('fork-like external steps reconcile by operation and digest without repeating dispatch', async () => {
  const storage = new MemoryJournal(clock)
  const coordinator = new SerializedEffectCoordinator(storage, clock)
  const steps = ['branch', 'checkpoint', 'environment', 'session', 'context'] as const
  let dispatches = 0

  for (const step of steps) {
    const forkIntent = {
      operationId: `op-fork-${step}`,
      effectKind: 'fork.step',
      request: { step, source: 'source-1' },
    } as const
    const requestDigest = effectRequestDigest(forkIntent)
    storage.appendEffect({
      operationId: forkIntent.operationId,
      effectKind: forkIntent.effectKind,
      requestDigest,
      status: 'pending',
      attempt: 1,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      metadata: { step },
    })
    const result = await coordinator.execute(forkIntent, {
      dispatch: async () => {
        dispatches += 1
        return { status: 'terminal' as const }
      },
      reconcile: async (context) => ({
        status: 'terminal' as const,
        externalReference: `reconciled:${context.request.step}`,
      }),
    })
    assert.equal(result.status, 'terminal')
  }

  assert.equal(dispatches, 0)
})

test('composition accepts the journal and effect ports while the deterministic fixture remains usable', async () => {
  const journal = new MemoryJournal(clock)
  const app = createBraidApplication({
    fixture: 'deterministic',
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-composed', text: 'through the seam' }).completion

  assert.equal(journal.all()[0]?.event.kind, 'workspace.opened')
  assert.equal(journal.current('op-composed')?.status, 'terminal')
})

test('a caller-provided journal is used through JournalPort rather than a production MemoryJournal import', () => {
  const events: BraidEventEnvelope[] = []
  const delegate = new MemoryJournal(clock)
  const journal: JournalPort = {
    envelope: (state, event) => delegate.envelope(state, event),
    append: (envelope) => {
      events.push(envelope)
      delegate.append(envelope)
    },
    all: () => delegate.all(),
  }
  const app = createBraidApplication({ fixture: 'deterministic', journal })

  app.initialize('/workspace')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.event.kind, 'workspace.opened')
})
