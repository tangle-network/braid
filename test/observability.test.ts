import assert from 'node:assert/strict'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import type { SandboxClientLike } from '@tangle-network/agent-provider-tangle'
import { observeSandboxClient } from '../src/adapters/runtime/sandbox-observation.js'
import { ApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { BraidApplication } from '../src/app/application.js'
import { MemoryJournal } from '../src/app/journal.js'
import { usageFromMetadata } from '../src/app/run-event-mapper.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import type { ExecutionEnvironmentObservation } from '../src/domain/execution-observation.js'
import { createConnectionId, createSupervisorId, createWorkerId } from '../src/domain/ids.js'
import { FixedClock } from '../src/ports/clock.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'
import { sessionUsageFor } from '../src/views/shared/usage-projection.js'

const at = '2026-08-09T12:00:00.000Z'

test('missing provider cost and latency remain unknown', () => {
  const usage = usageFromMetadata({ tokenUsage: { input: 2, output: 3 } })

  assert.deepEqual(usage, {
    input: 2,
    output: 3,
    usdKnown: false,
  })
})

test('malformed token metadata remains unknown instead of exact zero', () => {
  assert.deepEqual(
    usageFromMetadata({ tokenUsage: { inputTokens: 'bogus', outputTokens: 'bogus' } }),
    { input: 0, output: 0, tokensKnown: false, usdKnown: false },
  )
  assert.deepEqual(usageFromMetadata({ tokenUsage: { inputTokens: null, outputTokens: 3 } }), {
    input: 0,
    output: 3,
    tokensKnown: false,
    usdKnown: false,
  })
  assert.equal(
    usageFromMetadata({ tokenUsage: { input: Number.NaN, output: -1 } }).tokensKnown,
    false,
  )
})

test('sandbox observation captures identity, account usage, resources, and no credentials', async () => {
  let deleteAttempts = 0
  const source = {
    async getIdentity() {
      return {
        customerId: 'customer-1',
        billingOwnerId: 'billing-owner-1',
        apiKeyId: 'key-1',
        billingDelegationAuthorized: true,
      }
    },
    async usage() {
      return {
        computeMinutes: 42,
        gpuSeconds: 17,
        gpuCostUsd: 0.25,
        gpuProviderCostUsd: 0.2,
        activeSandboxes: 1,
        totalSandboxes: 8,
        periodStart: new Date('2026-08-09T00:00:00.000Z'),
        periodEnd: new Date('2026-08-10T00:00:00.000Z'),
      }
    },
    async subscription() {
      return {
        plan: 'pro' as const,
        status: 'active' as const,
        creditsAvailableUsd: 19.5,
        creditsUsedUsd: 3,
        monthlyBalanceUsd: 25,
        maxConcurrentSandboxes: 4,
        overageAllowed: true,
        limits: { maxCpuCores: 8, maxRamGB: 32, maxStorageGB: 200 },
        currentPeriodEnd: Date.parse('2026-09-01T00:00:00.000Z'),
      }
    },
    describePlacement() {
      return { kind: 'sandbox', machineId: 'machine-7', region: 'us-west-2' }
    },
    async create() {
      return {
        id: 'sandbox-123',
        name: 'observed-box',
        status: 'running',
        connection: {
          runtimeUrl: 'https://runtime.example/v1?token=top-secret',
          authToken: 'Bearer top-secret',
        },
        createdAt: new Date('2026-08-09T11:59:00.000Z'),
        startedAt: new Date('2026-08-09T11:59:02.000Z'),
        async *streamPrompt() {},
        async resourceUsage() {
          return {
            cgroupVersion: 2,
            memoryCurrentMb: 512,
            memoryPeakMb: 768,
            memoryLimitMb: 4096,
            cpuUsageUsec: 1_250_000,
            sampledAtMs: Date.parse(at),
          }
        },
        async delete() {
          deleteAttempts += 1
          if (deleteAttempts === 1) throw new Error('transient delete failure')
        },
      }
    },
  } as unknown as SandboxClientLike
  const observed = observeSandboxClient(
    source,
    { mode: 'ephemeral', cleanup: 'delete-after-turn', continuity: 'unavailable' },
    () => at,
  )

  const box = await observed.client.create({
    name: 'observed-box',
    ephemeral: true,
    resources: { cpuCores: 4, memoryMB: 8_192, diskGB: 50 },
  })
  await box.delete?.()
  const snapshot = await observed.observation.snapshot()

  assert.equal(deleteAttempts, 2)
  assert.equal(snapshot?.providerEnvironmentId, 'sandbox-123')
  assert.equal(snapshot?.lifecycle, 'destroyed')
  assert.equal(snapshot?.runtimeEndpointHost, 'runtime.example')
  assert.equal(snapshot?.machineId, 'machine-7')
  assert.equal(snapshot?.region, 'us-west-2')
  assert.equal(snapshot?.requestedResources?.cpuCores, 4)
  assert.equal(snapshot?.resourceSample?.memoryPeakMb, 768)
  assert.equal(snapshot?.account?.computeMinutes, 42)
  assert.equal(snapshot?.account?.creditsAvailableUsd, 19.5)
  assert.equal(snapshot?.account?.maximumStorageGB, 200)
  assert.equal(snapshot?.account?.completeness, 'provider-reported-possibly-defaulted')
  assert.match(snapshot?.unavailable.join('\n') ?? '', /machine-ip:not-exposed/)
  assert.doesNotMatch(
    snapshot?.unavailable.join('\n') ?? '',
    /account-or-placement-observation:pending/,
  )
  const serialized = JSON.stringify(snapshot)
  assert.doesNotMatch(serialized, /top-secret|Bearer|\/v1\?token/u)
})

test('sandbox cleanup continues when resource sampling throws', async () => {
  let deleteAttempts = 0
  const source = {
    async create() {
      return {
        id: 'sandbox-cleanup',
        status: 'running',
        async *streamPrompt() {},
        resourceUsage() {
          throw new Error('resource endpoint unavailable')
        },
        async delete() {
          deleteAttempts += 1
        },
      }
    },
  } as unknown as SandboxClientLike
  const observed = observeSandboxClient(
    source,
    { mode: 'ephemeral', cleanup: 'delete-after-turn', continuity: 'unavailable' },
    () => at,
  )

  const box = await observed.client.create({ name: 'cleanup-proof', ephemeral: true })
  await box.delete?.()
  const snapshot = await observed.observation.snapshot()

  assert.equal(deleteAttempts, 1)
  assert.equal(snapshot?.lifecycle, 'destroyed')
  assert.match(
    snapshot?.unavailable.join('\n') ?? '',
    /runtime-cpu-memory-usage:request-failed-or-timed-out/u,
  )
})

test('sandbox observation never guesses an unrecognized provider lifecycle', async () => {
  const source = {
    async create() {
      return {
        id: 'sandbox-future-status',
        status: 'provider-added-this-later',
        async *streamPrompt() {},
      }
    },
  } as unknown as SandboxClientLike
  const observed = observeSandboxClient(
    source,
    { mode: 'retained', cleanup: 'explicit', continuity: 'session' },
    () => at,
  )

  await observed.client.create({ name: 'future-status' })
  const snapshot = await observed.observation.snapshot()

  assert.equal(snapshot?.lifecycle, 'unknown')
  assert.match(
    snapshot?.unavailable.join('\n') ?? '',
    /sandbox-lifecycle:not-reported-or-unrecognized/u,
  )
})

test('one run projects honest session usage and a linked execution environment', async () => {
  const profile = defineAgentProfile({
    name: 'observability profile',
    harness: 'pi',
    model: { default: 'openai/gpt-5.6-luna' },
  })
  const connection: ConnectionRecord = {
    id: createConnectionId('connection-observability'),
    kind: 'tangle-sandbox',
    name: 'Tangle sandbox',
    endpoint: 'https://sandbox.example',
    providerOptions: { transport: 'https' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
  const observation: ExecutionEnvironmentObservation = {
    kind: 'sandbox',
    provider: 'tangle-sandbox',
    providerEnvironmentId: 'sandbox-observed',
    lifecycle: 'destroyed',
    lifecycleMode: 'ephemeral',
    cleanup: 'delete-after-turn',
    continuity: 'unavailable',
    location: 'remote',
    runtimeEndpointHost: 'runtime.example',
    requestedResources: { cpuCores: 2, memoryMB: 4_096 },
    resourceSample: {
      cgroupVersion: 2,
      memoryCurrentMb: 256,
      memoryPeakMb: 512,
      memoryLimitMb: 4_096,
      cpuUsageUsec: 900_000,
      sampledAt: at,
    },
    account: {
      scope: 'account',
      completeness: 'provider-reported-possibly-defaulted',
      customerId: 'customer-observed',
      computeMinutes: 12,
      creditsAvailableUsd: 8,
      maximumCpuCores: 8,
      maximumRamGB: 32,
      maximumStorageGB: 200,
      sampledAt: at,
    },
    createdAt: at,
    startedAt: at,
    observedAt: at,
    unavailable: ['machine-ip:not-exposed-by-provider'],
  }
  const execution: ExecutionPort = {
    admit: () => ({
      provider: 'tangle-sandbox',
      materializationReceipt: { provider: 'tangle-sandbox', backend: 'executor' },
    }),
    async *streamTurn() {
      yield {
        type: 'llm_call',
        model: 'openai/gpt-5.6-luna',
        tokensIn: 11,
        tokensOut: 7,
        tokensKnown: false,
        costUsd: 0.12,
        usdKnown: false,
        estimatedCostUsd: 0.15,
        latencyMs: 240,
        timestamp: at,
      }
      yield { type: 'braid.execution.observed', observation, timestamp: at }
      yield {
        type: 'final',
        status: 'completed',
        reason: 'observability test completed',
        text: 'done',
        metadata: {},
        task: { id: 'task-observability', intent: 'prove observability' },
        timestamp: at,
      }
    },
  }
  const journal = new MemoryJournal(new FixedClock(at))
  const app = new BraidApplication({
    profile,
    execution,
    clock: new FixedClock(at),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const controller = new ApplicationUiController(app, {}, undefined, {
    connections: [connection],
  })
  await controller.dispatch({
    type: 'headless-command',
    command: 'select_connection',
    operationId: 'op-select-observability',
    params: { connectionId: connection.id },
  })

  const receipt = app.send({ operationId: 'op-observability', text: 'measure this turn' })
  const state = await receipt.completion
  const run = state.runs.at(-1)
  assert.ok(run)
  const headless = controller.state()

  assert.equal(run?.receipt.provider, 'tangle-sandbox')
  assert.equal(run?.connectionId, connection.id)
  assert.equal(run?.tokensKnown, false)
  assert.equal(run?.usdKnown, false)
  assert.equal(run?.inputTokens, 11)
  assert.equal(run?.outputTokens, 7)
  assert.equal(run?.costUsd, 0.12)
  assert.equal(run?.estimatedCostUsd, 0.15)
  assert.equal(run?.model, 'openai/gpt-5.6-luna')
  assert.equal(run?.llmCalls, 1)
  assert.equal(run?.llmLatencyMs, 240)
  assert.equal(run?.lastProviderSequence, 3)
  assert.equal(run?.eventCount, 3)
  assert.equal(state.missingHistory.length, 0)
  assert.equal(state.environments.length, 1)
  assert.equal(run?.environmentId, state.environments[0]?.id)
  assert.equal(state.environments[0]?.providerEnvironmentId, 'sandbox-observed')
  assert.equal(headless.sessionUsage.turns.tokenStatus, 'observed-floor')
  assert.equal(headless.sessionUsage.turns.costStatus, 'observed-floor')
  assert.equal(headless.sessionUsage.turns.estimatedCostUsd, 0.15)
  assert.equal(headless.environments[0]?.cleanup, 'delete-after-turn')
  assert.equal(headless.environments[0]?.resourceSample?.cgroupVersion, 2)
  assert.equal(headless.environments[0]?.accountUsage?.maximumStorageGB, 200)
  assert.equal(controller.view().environments[0]?.runtimeEndpointHost, 'runtime.example')
  assert.ok(
    state.graphEdges.some((edge) =>
      state.graphNodes.some(
        (node) => node.id === edge.destination && node.reference.kind === 'environment',
      ),
    ),
  )

  const supervisorId = createSupervisorId('supervisor-observability')
  const delegated = sessionUsageFor({
    ...state,
    supervisors: [
      {
        id: supervisorId,
        runtimeId: 'runtime-supervisor-observability',
        runtimeRoot: '/workspace',
        rootRunId: run.id,
        status: 'completed',
        totalUsage: {
          inputTokens: 1_000,
          outputTokens: 2_000,
          spendUsd: 9,
          latencyMs: 3_000,
          completeness: 'observed-floor',
        },
        createdAt: at,
        updatedAt: at,
      },
    ],
    workers: [
      {
        id: createWorkerId('worker-observability'),
        runtimeId: 'runtime-worker-observability',
        supervisorId,
        status: 'completed',
        inputTokens: 5,
        outputTokens: 7,
        spendUsd: 0.02,
        latencyMs: 80,
        usageCompleteness: 'observed-floor',
        createdAt: at,
        updatedAt: at,
      },
    ],
  }).delegated
  assert.equal(delegated.input, 5)
  assert.equal(delegated.output, 7)
  assert.equal(delegated.costUsd, 0.02)
  assert.equal(delegated.llmLatencyMs, 80)
  assert.equal(delegated.tokenStatus, 'observed-floor')
})
