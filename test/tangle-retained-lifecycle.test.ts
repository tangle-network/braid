import assert from 'node:assert/strict'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import {
  resolveTangleSandboxBackend,
  resolveTangleSandboxRetainedConnection,
} from '../src/adapters/runtime/production-tangle-sandbox-backend.js'
import { capabilitiesForConnection } from '../src/adapters/connections/production-connection-providers.js'
import {
  createTangleRetainedPlan,
  startTangleRetainedRun,
} from '../src/adapters/runtime/tangle-retained-run.js'
import { withRetainedSandboxPolicy } from '../src/adapters/runtime/tangle-sandbox-retention.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import type { ObservableSandboxClient } from '../src/adapters/runtime/sandbox-observation-types.js'
import type { ConnectionRecord, ConnectionTransportOptions } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import { assertConnectionRecord } from '../src/domain/invariants-profile.js'
import type { RetainedRunAdmissionRecord } from '../src/ports/execution.js'
import {
  FakeTangleRetainedSandbox,
  prepareFakeTangleRetainedConnection,
} from './support/tangle-retained-sandbox.js'

const now = '2026-08-12T12:00:00.000Z'
const profile = defineAgentProfile({
  name: 'Retained Tangle test',
  harness: 'opencode',
  model: { provider: 'openai', default: 'openai/gpt-5' },
})

function record(providerOptions: ConnectionTransportOptions): ConnectionRecord {
  return {
    id: createConnectionId('connection-tangle-retained-test'),
    kind: 'tangle-sandbox',
    name: 'Tangle Sandbox',
    endpoint: 'https://sandbox.test',
    providerOptions,
    createdAt: now,
    updatedAt: now,
    lastHealth: { status: 'unknown' },
  }
}

function setup(sandbox: FakeTangleRetainedSandbox, providerSessionId?: string) {
  const connection = record({
    transport: 'https',
    lifecycle: 'retained',
    idleTtlSeconds: 1_800,
  })
  const options = {
    connections: new ConnectionRegistry([connection]),
    select: () => ({ connection: { connectionId: connection.id } }),
    sandboxClient: sandbox.client(),
  }
  const admissions: RetainedRunAdmissionRecord[] = []
  const input = {
    operationId: 'operation-tangle-retained',
    runId: 'run/tangle-retained',
    text: 'Prove retained cloud execution.',
    profile,
    connectionId: connection.id,
    signal: new AbortController().signal,
    onRetainedAdmission: async (admission: RetainedRunAdmissionRecord) => {
      admissions.push(structuredClone(admission))
    },
    ...(providerSessionId === undefined ? {} : { sessionId: providerSessionId }),
  }
  const selection = { connection: { connectionId: connection.id } }
  return { admissions, connection, options, input, selection }
}

test('retained lifecycle configuration is explicit and bounded', () => {
  assert.doesNotThrow(() =>
    assertConnectionRecord(record({ lifecycle: 'retained', idleTtlSeconds: 1_800 })),
  )
  assert.throws(
    () => assertConnectionRecord(record({ lifecycle: 'retained' })),
    /requires idleTtlSeconds/u,
  )
  assert.throws(
    () => assertConnectionRecord(record({ lifecycle: 'retained', idleTtlSeconds: 59 })),
    /60 to 604800/u,
  )
  assert.throws(
    () => assertConnectionRecord(record({ lifecycle: 'ephemeral', idleTtlSeconds: 1_800 })),
    /requires lifecycle=retained/u,
  )
})

test('retained policy fails closed for an ambiguous completed-turn 404', async () => {
  let responseStatus = 404
  let dispatches = 0
  const box = {
    id: 'sandbox-completed-turn-contract',
    async *streamPrompt() {},
    async findCompletedTurn() {
      throw Object.assign(new Error(`${responseStatus} completed-turn response`), {
        status: responseStatus,
        code: responseStatus === 404 ? 'NOT_FOUND' : 'SERVER_ERROR',
      })
    },
    async dispatchPrompt(
      this: {
        findCompletedTurn(
          turnId: string,
          options: { readonly sessionId: string },
        ): Promise<unknown | null>
      },
      _message: unknown,
      options: { readonly sessionId?: string; readonly turnId?: string } = {},
    ) {
      const sessionId = options.sessionId ?? 'missing-session'
      const turnId = options.turnId ?? 'missing-turn'
      const cached = await this.findCompletedTurn(turnId, { sessionId })
      dispatches += 1
      return { sessionId, dispatched: true, cached }
    },
  }
  const client = withRetainedSandboxPolicy({ create: async () => box as never }, 300)
  const retained = await client.create()
  const dispatch = retained.dispatchPrompt
  assert.ok(dispatch)

  await assert.rejects(
    dispatch.call(retained, 'run once', {
      sessionId: 'session-completed-turn-contract',
      turnId: 'turn-completed-turn-contract',
    }),
    /404 completed-turn response/u,
  )
  assert.equal(dispatches, 0)

  responseStatus = 500
  await assert.rejects(
    (
      retained as typeof retained & {
        findCompletedTurn(turnId: string, options: { sessionId: string }): Promise<unknown | null>
      }
    ).findCompletedTurn('turn-completed-turn-contract', {
      sessionId: 'session-completed-turn-contract',
    }),
    /500 completed-turn response/u,
  )
})

test('retained policy preserves account observation methods from the Sandbox client', async () => {
  const identity = {
    customerId: 'customer-retained-policy',
    billingOwnerId: 'billing-retained-policy',
    apiKeyId: null,
    billingDelegationAuthorized: false,
  }
  const usage = {
    computeMinutes: 1,
    gpuSeconds: 0,
    gpuCostUsd: 0,
    gpuProviderCostUsd: 0,
    activeSandboxes: 0,
    totalSandboxes: 1,
    periodStart: new Date('2026-08-12T00:00:00.000Z'),
    periodEnd: new Date('2026-08-13T00:00:00.000Z'),
  }
  const source = {
    async create() {
      return {} as never
    },
    async getIdentity() {
      return identity
    },
    async usage() {
      return usage
    },
  } as ObservableSandboxClient
  const retained = withRetainedSandboxPolicy(source, 300) as ObservableSandboxClient

  assert.deepEqual(await retained.getIdentity?.(), identity)
  assert.deepEqual(await retained.usage?.(), usage)
})

test('retained capability and resolution fail closed without exact lookup methods', async () => {
  const sandbox = new FakeTangleRetainedSandbox()
  const configured = setup(sandbox)
  const source = configured.options.sandboxClient
  if (source.fetch === undefined || source.get === undefined) {
    throw new Error('Fake retained client requires fetch and get')
  }
  const options = {
    ...configured.options,
    sandboxClient: {
      create: source.create,
      fetch: source.fetch,
      get: source.get,
    },
  }
  const { connection, input, selection } = configured
  const report = await capabilitiesForConnection(connection, options)
  assert.equal(report.runtime.streaming.live, false)
  assert.equal(report.actions.stream, false)
  await assert.rejects(
    resolveTangleSandboxRetainedConnection(options, input, selection, connection.id),
    /requires Sandbox list and get/u,
  )

  assert.equal(sandbox.createCalls.length, 0)
  await assert.rejects(
    resolveTangleSandboxBackend(options, input, selection, connection.id),
    /retained execution port/u,
  )
})

test('published Sandbox methods recover the exact retained dispatch without an injected lookup', async () => {
  const sandbox = new FakeTangleRetainedSandbox()
  const { connection, options, input, selection } = setup(sandbox)
  const report = await capabilitiesForConnection(connection, options)
  assert.equal(report.runtime.streaming.live, true)
  assert.equal(report.actions.stream, true)

  const prepared = await resolveTangleSandboxRetainedConnection(
    options,
    input,
    selection,
    connection.id,
  )
  assert.equal(await prepared.discoverControlRef(input.runId), null)
  const handle = await startTangleRetainedRun(
    createTangleRetainedPlan(prepared, input.runId),
    input,
  )
  assert.deepEqual(await prepared.discoverControlRef(input.runId), handle.controlRef)
})

test('retained resolution admits exact control when provider lookup is configured', async () => {
  const sandbox = new FakeTangleRetainedSandbox()
  const { connection, options, input, selection } = setup(sandbox)
  const prepared = await resolveTangleSandboxRetainedConnection(
    { ...options, tangleRetainedControlLookup: async () => null },
    input,
    selection,
    connection.id,
  )
  assert.equal(prepared.capabilities.retainedControl?.exactRunIdentity, true)
  assert.equal(prepared.capabilities.streaming.detach, true)
  assert.equal(sandbox.createCalls.length, 0)
})

test('one retained plan uses exact tags, bounded idle expiry, replay, and result identity', async () => {
  const sandbox = new FakeTangleRetainedSandbox()
  const { admissions, input } = setup(sandbox)
  const prepared = await prepareFakeTangleRetainedConnection({
    sandbox,
    profile,
    runId: input.runId,
  })
  const plan = createTangleRetainedPlan(prepared, input.runId)
  assert.equal(plan.capabilities.sessions.continue, false)
  assert.equal(plan.capabilities.controls.status, false)
  const handle = await startTangleRetainedRun(plan, input)

  assert.equal(sandbox.createCalls.length, 1)
  assert.equal(sandbox.createCalls[0]?.idempotencyKey, prepared.environmentIdempotencyKey)
  assert.equal(sandbox.createCalls[0]?.name, prepared.environmentName)
  assert.equal(sandbox.createCalls[0]?.idleTimeoutSeconds, 1_800)
  assert.equal(sandbox.createCalls[0]?.ephemeral, false)
  assert.deepEqual(sandbox.createCalls[0]?.metadata, {
    ...prepared.environmentMetadata,
    retainedIdempotencyKey: prepared.environmentIdempotencyKey,
    sessionId: prepared.providerSessionId,
    executionId: 'run-tangle-retained',
  })
  assert.equal(handle.controlRef.environmentId, sandbox.boxes[0]?.id)
  assert.equal(handle.controlRef.sessionId, prepared.providerSessionId)
  assert.equal(handle.controlRef.executionId, 'run-tangle-retained')
  assert.match(handle.controlRef.requestDigest, /^sha256:[0-9a-f]{64}$/u)
  assert.deepEqual(
    admissions.map((admission) => admission.phase),
    ['environment', 'dispatched'],
  )

  sandbox.complete(handle.controlRef.executionId, 'RETAINED_OK')
  const events = []
  for await (const event of handle.events()) events.push(event)
  assert.deepEqual(
    events.map((event) => event.cursor),
    [`event-${handle.controlRef.executionId}-1`, `event-${handle.controlRef.executionId}-2`],
  )
  const result = await handle.result()
  assert.equal(result.text, 'RETAINED_OK')
  assert.equal(result.metadata?.executionId, handle.controlRef.executionId)

  const reconnected = await plan.reconnect(handle.controlRef)
  assert.deepEqual(reconnected?.controlRef, handle.controlRef)
  const replayed = []
  const firstEvent = events[0]
  if (firstEvent?.cursor === undefined) throw new Error('First retained event omitted its cursor')
  for await (const event of reconnected?.events({
    after: { cursor: firstEvent.cursor, sequence: firstEvent.sequence },
  }) ?? []) {
    replayed.push(event)
  }
  assert.deepEqual(
    replayed.map((event) => event.cursor),
    [events[1]?.cursor],
  )
})

test('ambiguous dispatch failure never deletes the retained environment', async () => {
  const sandbox = new FakeTangleRetainedSandbox()
  sandbox.failDispatch = true
  const { input } = setup(sandbox)
  const prepared = await prepareFakeTangleRetainedConnection({
    sandbox,
    profile,
    runId: input.runId,
  })
  const plan = createTangleRetainedPlan(prepared, input.runId)

  await assert.rejects(startTangleRetainedRun(plan, input), /dispatch failure/u)
  assert.equal(sandbox.createCalls.length, 1)
  assert.equal(sandbox.boxes.length, 1)
  assert.equal(sandbox.createCalls[0]?.idleTimeoutSeconds, 1_800)
})

test('a failed retry never deletes a pre-existing retained workspace', async () => {
  const sandbox = new FakeTangleRetainedSandbox()
  const { input } = setup(sandbox, 'session-braid-existing-workspace')
  const providerSessionId = input.sessionId
  assert.ok(providerSessionId)
  const prepared = await prepareFakeTangleRetainedConnection({
    sandbox,
    profile,
    runId: input.runId,
    providerSessionId,
  })
  const first = await startTangleRetainedRun(createTangleRetainedPlan(prepared, input.runId), input)
  sandbox.complete(first.controlRef.executionId, 'EXISTING_WORKSPACE')
  sandbox.failDispatch = true
  const retryInput = {
    ...input,
    operationId: 'operation-tangle-retained-retry',
    runId: 'run/tangle-retained-retry',
  }

  await assert.rejects(
    startTangleRetainedRun(createTangleRetainedPlan(prepared, retryInput.runId), retryInput),
    /dispatch failure/u,
  )
  assert.equal(sandbox.boxes.length, 1)
})

test('exact cancellation is retry-safe through the Runtime handle', async () => {
  const sandbox = new FakeTangleRetainedSandbox()
  const { input } = setup(sandbox)
  const prepared = await prepareFakeTangleRetainedConnection({
    sandbox,
    profile,
    runId: input.runId,
  })
  const plan = createTangleRetainedPlan(prepared, input.runId)
  const handle = await startTangleRetainedRun(plan, input)
  const first = await handle.cancel({ operationId: 'operation-cancel', reason: 'test' })
  const replay = await handle.cancel({ operationId: 'operation-cancel', reason: 'test' })

  assert.equal(first.status, 'accepted')
  assert.equal(first.effect, 'cancelled')
  assert.equal(replay.status, 'replayed')
  assert.equal(replay.effect, 'cancelled')
  assert.equal(sandbox.cancellations.length, 2)
  assert.equal(sandbox.cancellations[0]?.run.executionId, handle.controlRef.executionId)
})
