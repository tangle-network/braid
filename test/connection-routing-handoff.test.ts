import { createAdmissionReceipt } from '../src/domain/receipts.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { ConnectionRoutingExecutionPort } from '../src/adapters/runtime/connection-routing-execution.js'
import { ConnectionRegistry, connectionExecutionDigest } from '../src/app/connections.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecuteTurnInput,
  type ExecutionPort,
} from '../src/ports/execution.js'

const record: ConnectionRecord = {
  id: createConnectionId('connection-handoff-admission'),
  kind: 'cli-bridge',
  name: 'Accepted account',
  endpoint: 'http://127.0.0.1:9000',
  providerOptions: { transport: 'local' },
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  lastHealth: { status: 'unknown' },
}
const input: ExecuteTurnInput = {
  operationId: 'operation-handoff-admission',
  runId: 'run-handoff-admission',
  text: 'Continue on the accepted account',
  profile: defineAgentProfile({ name: 'Handoff', harness: 'pi' }),
  connectionId: record.id,
  expectedConnectionDigest: connectionExecutionDigest(record),
  signal: new AbortController().signal,
}
const admission = { capabilities: DEFAULT_RUN_CAPABILITIES, materializationReceipt: {} }

test('routing refuses a changed handoff destination before constructing any adapter', async () => {
  const connections = new ConnectionRegistry([record])
  let created = 0
  const routing = new ConnectionRoutingExecutionPort({
    connections,
    defaultConnectionId: record.id,
    create() {
      created += 1
      return { admit: () => admission, async *streamTurn() {} }
    },
  })
  connections.upsert({ ...record, endpoint: 'http://127.0.0.1:9001' })
  await assert.rejects(() => routing.admit(input), /destination connection changed/)
  assert.equal(created, 0)
})

test('routing retains the validated immutable account across asynchronous admission and dispatch', async () => {
  const connections = new ConnectionRegistry([record])
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const constructed: ConnectionRecord[] = []
  const dispatched: ConnectionRecord[] = []
  const routing = new ConnectionRoutingExecutionPort({
    connections,
    defaultConnectionId: record.id,
    create(connection): ExecutionPort {
      constructed.push(connection)
      return {
        async admit() {
          await pending
          return admission
        },
        async *streamTurn() {
          dispatched.push(connection)
          yield* []
        },
      }
    },
  })
  const admitting = routing.admit(input)
  const changed = { ...record, endpoint: 'http://127.0.0.1:9001' }
  connections.upsert(changed)
  release()
  await admitting
  for await (const _event of routing.streamTurn(input)) {
    /* drain */
  }
  assert.equal(constructed.length, 1)
  assert.equal(dispatched[0]?.endpoint, record.endpoint)
  assert.equal(Object.isFrozen(constructed[0]), true)
  await assert.rejects(
    () => routing.admit({ ...input, expectedConnectionDigest: connectionExecutionDigest(changed) }),
    /destination connection changed/,
  )
})

test('health observations do not invalidate the accepted destination or its cached adapter', async () => {
  const connections = new ConnectionRegistry([record])
  let constructed = 0
  let dispatched = 0
  const routing = new ConnectionRoutingExecutionPort({
    connections,
    defaultConnectionId: record.id,
    create(): ExecutionPort {
      constructed += 1
      return {
        admit: () => admission,
        async *streamTurn() {
          dispatched += 1
          yield* []
        },
      }
    },
  })
  await routing.admit({ ...input, runId: 'run-before-health' })
  const observed = {
    ...record,
    lastHealth: { status: 'healthy' as const, checkedAt: '2026-10-12T00:00:00.000Z' },
  }
  connections.upsert(observed)
  const accepted = { ...input, expectedConnectionDigest: connectionExecutionDigest(observed) }
  await routing.admit(accepted)
  for await (const _event of routing.streamTurn(accepted)) {
    /* drain */
  }
  assert.equal(constructed, 1)
  assert.equal(dispatched, 1)
})

for (const known of [false, true]) {
  test(`recovery enforces the accepted destination without a materialization receipt, known=${known}`, async () => {
    const connections = new ConnectionRegistry([record])
    let constructed = 0
    let controlled = 0
    const routing = new ConnectionRoutingExecutionPort({
      connections,
      defaultConnectionId: record.id,
      create(): ExecutionPort {
        constructed += 1
        return {
          admit: () => admission,
          async *streamTurn() {},
          async status(value) {
            controlled += 1
            return { runId: value.runId, status: 'running' }
          },
        }
      },
    })
    if (known) await routing.admit(input)
    const changed = { ...record, endpoint: 'http://127.0.0.1:9001' }
    if (!known) connections.upsert(changed)
    const receipt = createAdmissionReceipt({
      runId: input.runId,
      turnId: 'turn-handoff-recovery',
      operationId: input.operationId,
      conversationId: 'conversation-handoff-recovery',
      branchId: 'branch-handoff-recovery',
      admittedAt: record.createdAt,
      profile: input.profile,
      text: input.text,
      connectionId: record.id,
      expectedConnectionDigest: connectionExecutionDigest(known ? changed : record),
      capabilities: DEFAULT_RUN_CAPABILITIES,
      admissionStatus: 'pending',
    })
    assert.equal(receipt.materializationReceipt, undefined)
    await assert.rejects(
      () => routing.status({ runId: input.runId, receipt }),
      /connection changed/,
    )
    assert.equal(constructed, known ? 1 : 0)
    assert.equal(controlled, 0)
  })
}
