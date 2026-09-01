import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type AgentExactRunControlRef,
  AgentExactRunControlRefSchema,
  defineAgentProfile,
} from '@tangle-network/agent-interface'
import type { SandboxClientLike, SandboxInstanceLike } from '@tangle-network/agent-provider-tangle'
import type { SessionInfo } from '@tangle-network/sandbox'
import { createTangleRetainedControlLookup } from '../src/adapters/connections/tangle-retained-control-lookup.js'
import {
  createTangleRetainedPlan,
  startTangleRetainedRun,
} from '../src/adapters/runtime/tangle-retained-run.js'
import { retainedSandboxIdentity } from '../src/adapters/runtime/tangle-sandbox-retention.js'
import { createConnectionId } from '../src/domain/ids.js'
import type { RetainedRunAdmissionRecord } from '../src/ports/execution.js'
import {
  FakeTangleRetainedSandbox,
  prepareFakeTangleRetainedConnection,
} from './support/tangle-retained-sandbox.js'

const profile = defineAgentProfile({
  name: 'Tangle reconstruction test',
  harness: 'opencode',
  model: { provider: 'openai', default: 'openai/gpt-5' },
})

test('two process instances recover one exact retained Tangle control reference', async () => {
  const providerSessionId = 'session-braid-reconstruction'
  const executionId = 'run-reconstruction'
  const identity = retainedSandboxIdentity(providerSessionId)
  const controlRef: AgentExactRunControlRef = AgentExactRunControlRefSchema.parse({
    runId: 'provider-run-reconstruction',
    provider: 'tangle-sandbox',
    environmentId: 'sandbox-reconstruction',
    sessionId: providerSessionId,
    executionId,
    requestDigest: `sha256:${'b'.repeat(64)}`,
  })
  const metadata = {
    ...identity.metadata,
    retainedIdempotencyKey: identity.environmentIdempotencyKey,
  }
  const sessionStatus: SessionInfo = {
    id: providerSessionId,
    status: 'completed',
    latestExecutionId: executionId,
    runControlRef: controlRef,
  }
  let listCalls = 0
  let getCalls = 0
  let statusCalls = 0

  const createProcessClient = (): SandboxClientLike => {
    const box: SandboxInstanceLike = {
      id: controlRef.environmentId,
      name: identity.name,
      metadata,
      async *streamPrompt() {},
      session(sessionId) {
        assert.equal(sessionId, providerSessionId)
        return {
          id: sessionId,
          async status() {
            statusCalls += 1
            return sessionStatus
          },
        } as never
      },
    }
    return {
      create: async () => box,
      list: async () => {
        listCalls += 1
        return [box]
      },
      get: async (id) => {
        getCalls += 1
        assert.equal(id, controlRef.environmentId)
        return box
      },
    }
  }

  const input = {
    connectionId: createConnectionId('connection-tangle-reconstruction'),
    braidRunId: 'run/reconstruction',
    providerSessionId,
    executionId,
    environmentIdempotencyKey: identity.environmentIdempotencyKey,
  }
  const processOneLookup = createTangleRetainedControlLookup(createProcessClient())
  const processTwoLookup = createTangleRetainedControlLookup(createProcessClient())

  const [processOneControl, processTwoControl] = await Promise.all([
    processOneLookup(input),
    processTwoLookup(input),
  ])

  assert.deepEqual(processOneControl, controlRef)
  assert.deepEqual(processTwoControl, controlRef)
  assert.equal(listCalls, 2)
  assert.equal(getCalls, 2)
  assert.equal(statusCalls, 2)
  assert.deepEqual(metadata, {
    owner: 'braid',
    lifecycle: 'retained',
    providerSessionId,
    retainedIdempotencyKey: identity.environmentIdempotencyKey,
  })
  assert.equal('sessionId' in metadata, false)
  assert.equal('executionId' in metadata, false)
})

test('two Tangle provider instances recover Runtime environment admissions', async () => {
  const sandbox = new FakeTangleRetainedSandbox()
  const firstPrepared = await prepareFakeTangleRetainedConnection({
    sandbox,
    profile,
    runId: 'run/provider-reconstruction',
  })
  const admissions: RetainedRunAdmissionRecord[] = []
  const input = {
    operationId: 'operation/provider-reconstruction',
    runId: 'run/provider-reconstruction',
    turnId: 'turn/provider-reconstruction',
    text: 'Recover this retained run.',
    profile,
    signal: new AbortController().signal,
    onRetainedAdmission: async (admission: RetainedRunAdmissionRecord) => {
      admissions.push(structuredClone(admission))
    },
  }
  const firstHandle = await startTangleRetainedRun(
    createTangleRetainedPlan(firstPrepared, input.runId),
    input,
  )
  const environmentAdmission = admissions.find((admission) => admission.phase === 'environment')
  assert.ok(environmentAdmission)

  const secondPrepared = await prepareFakeTangleRetainedConnection({
    sandbox,
    profile,
    runId: input.runId,
    providerSessionId: firstPrepared.providerSessionId,
  })
  assert.notStrictEqual(secondPrepared.provider, firstPrepared.provider)
  const secondPlan = createTangleRetainedPlan(secondPrepared, input.runId, undefined, {
    retainedAdmission: environmentAdmission,
  })
  const recovered = await secondPlan.recover?.({ admission: environmentAdmission })

  assert.ok(recovered)
  assert.deepEqual(recovered.controlRef, firstHandle.controlRef)
})
