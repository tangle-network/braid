import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentExactRunControlRef,
  AgentWorkspaceBranchingProvider,
  ContextTransferRequest,
  ContextTransferResult,
  WorkspaceCheckpointRequest,
  WorkspaceCheckpointResult,
  WorkspaceForkRequest,
  WorkspaceForkResult,
} from '@tangle-network/agent-interface'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { canonicalAgentProfileDigestHex } from '../src/adapters/agent-interface/profile-runtime.js'
import { createBraidApplication } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createOperationId } from '../src/domain/ids.js'
import { FixedClock } from '../src/ports/clock.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecutionPort,
  type RunCapabilities,
} from '../src/ports/execution.js'

const AT = '2026-08-28T00:00:00.000Z'
const SOURCE_PROVIDER = 'source-provider'
const TARGET_PROVIDER = 'target-provider'
const SOURCE_SESSION = 'provider-session-source'

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

interface WorkspaceProviderState {
  readonly checkpoints: Map<
    string,
    Extract<WorkspaceCheckpointResult, { readonly status: 'created' | 'replayed' }>
  >
  readonly forks: Map<
    string,
    Extract<WorkspaceForkResult, { readonly status: 'created' | 'replayed' }>
  >
  readonly checkpointRequests: WorkspaceCheckpointRequest[]
  readonly forkRequests: WorkspaceForkRequest[]
  readonly cleanupRequests: Array<{
    readonly kind: 'checkpoint' | 'fork'
    readonly targetId: string
    readonly operationId: string
  }>
}

interface ContextProviderState {
  readonly transfers: ContextTransferRequest[]
}

function sourceConnection(): ConnectionRecord {
  return {
    id: createConnectionId('connection-branch-effects-source'),
    kind: 'tangle-sandbox',
    name: 'branch effects source',
    providerOptions: { transport: 'local' },
    createdAt: AT,
    updatedAt: AT,
    lastHealth: { status: 'unknown' },
  }
}

function exactControl(input: {
  readonly runId: string
  readonly provider: string
  readonly environmentId: string
  readonly sessionId: string
  readonly executionId: string
  readonly requestDigest?: string
}): AgentExactRunControlRef {
  return {
    runId: input.runId,
    provider: input.provider,
    environmentId: input.environmentId,
    sessionId: input.sessionId,
    executionId: input.executionId,
    requestDigest: `sha256:${input.requestDigest ?? '1'.repeat(64)}`,
  }
}

function branchCapabilities(workspace = false): RunCapabilities {
  return {
    ...DEFAULT_RUN_CAPABILITIES,
    streaming: { ...DEFAULT_RUN_CAPABILITIES.streaming, replay: true },
    sessions: { continue: true, messages: true },
    events: { stableIdentity: true, sequence: true, cursor: true },
    environment: {
      branching: {
        checkpoint: workspace,
        fork: workspace,
        retrySafe: workspace,
        lookup: workspace,
        cleanup: workspace,
      },
      confidential: workspace,
    },
  } as unknown as RunCapabilities
}

function contextResult(request: ContextTransferRequest): ContextTransferResult {
  const plan = request.plan
  const included = plan.messages
    .filter((message) => message.action === 'include')
    .map((message) => message.messageId)
  const omitted = plan.messages
    .filter((message) => message.action === 'omit')
    .map((message) => message.messageId)
  return {
    status: 'accepted',
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    planDigest: plan.digest,
    contextDigest: plan.context.digest,
    source: plan.source.source,
    destination: plan.destination,
    provider: plan.destination.provider,
    environmentId: plan.destination.environmentId,
    sessionId: plan.destination.sessionId,
    runId: plan.destination.runId,
    executionId: plan.destination.executionId,
    sessionCreatedForOperationId: request.operationId,
    sessionCreatedAt: AT,
    transferredMessageIds: included,
    omittedMessageIds: omitted,
    admittedAt: AT,
  }
}

function workspaceProvider(): {
  readonly branching: NonNullable<ExecutionPort['workspaceBranching']>
  readonly state: WorkspaceProviderState
} {
  const state: WorkspaceProviderState = {
    checkpoints: new Map(),
    forks: new Map(),
    checkpointRequests: [],
    forkRequests: [],
    cleanupRequests: [],
  }
  const branching: NonNullable<ExecutionPort['workspaceBranching']> = {
    async checkpoint(request) {
      state.checkpointRequests.push(request)
      const result: WorkspaceCheckpointResult = {
        status: 'created',
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        checkpoint: {
          checkpointId: 'provider-checkpoint-1',
          provider: request.source.provider,
          source: request.source,
          idempotencyKey: request.idempotencyKey,
          requestDigest: request.requestDigest,
          createdAt: AT,
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
      }
      state.checkpoints.set(request.idempotencyKey, result)
      return result
    },
    async lookupCheckpoint(request) {
      const result = state.checkpoints.get(request.idempotencyKey)
      return result === undefined
        ? { status: 'not_found', ...request }
        : { status: 'found', ...request, checkpoint: result.checkpoint }
    },
    async deleteCheckpoint(request) {
      state.cleanupRequests.push({
        kind: 'checkpoint',
        targetId: request.targetId,
        operationId: request.operationId,
      })
      return {
        operationId: request.operationId,
        kind: 'checkpoint' as const,
        targetId: request.targetId,
        provider: request.provider,
        requestDigest: request.requestDigest,
        status: 'deleted' as const,
      }
    },
    async fork(request) {
      state.forkRequests.push(request)
      const confidential = request.confidential
      const confidentialAttestation =
        confidential?.requested === true &&
        confidential.nonce !== undefined &&
        confidential.policy !== undefined &&
        confidential.profileDigest !== undefined
          ? {
              provider: request.checkpoint.provider,
              requested: true as const,
              nonce: confidential.nonce,
              measurement: `sha256:${'a'.repeat(64)}` as `sha256:${string}`,
              environmentId: 'provider-destination-environment',
              source: request.checkpoint.source,
              requestDigest: request.requestDigest,
              profileDigest: confidential.profileDigest,
              policy: confidential.policy,
              quote: 'provider-quote',
              providerKeyId: 'trusted-provider-key',
              providerSignature: 'trusted-provider-signature',
              verifiedAt: AT,
            }
          : undefined
      const result: WorkspaceForkResult = {
        status: 'created',
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        environment: {
          provider: request.checkpoint.provider,
          environmentId: 'provider-destination-environment',
          sourceEnvironmentId: request.checkpoint.source.environmentId,
          source: request.checkpoint.source,
          sourceCheckpointId: request.checkpoint.checkpointId,
          idempotencyKey: request.idempotencyKey,
          requestDigest: request.requestDigest,
          createdAt: AT,
          placement: request.placement,
          confidentialRequested: request.confidential?.requested ?? false,
          ...(confidentialAttestation === undefined ? {} : { confidentialAttestation }),
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
      }
      state.forks.set(request.idempotencyKey, result)
      return result
    },
    async lookupFork(request) {
      const result = state.forks.get(request.idempotencyKey)
      return result === undefined
        ? { status: 'not_found', ...request }
        : { status: 'found', ...request, environment: result.environment }
    },
    async destroyFork(request) {
      state.cleanupRequests.push({
        kind: 'fork',
        targetId: request.targetId,
        operationId: request.operationId,
      })
      return {
        operationId: request.operationId,
        kind: 'fork' as const,
        targetId: request.targetId,
        provider: request.provider,
        requestDigest: request.requestDigest,
        status: 'deleted' as const,
      }
    },
  }
  return { branching, state }
}

async function prepareSource(app: ReturnType<typeof createBraidApplication>): Promise<void> {
  app.initialize('/workspace')
  const connection = sourceConnection()
  await app.configuration.selectConnection({
    connection,
    operation: {
      id: createOperationId('operation-select-branch-effects-source'),
      kind: 'connection-change',
      requestDigest: canonicalDigest({
        command: 'select_connection',
        connectionId: connection.id,
      }),
      status: 'acknowledged',
      target: { kind: 'connection', id: connection.id },
      result: { connectionId: connection.id },
      createdAt: AT,
      updatedAt: AT,
      acknowledgedAt: AT,
    },
  })
}

function executionFor(options: {
  readonly capabilities: ReturnType<typeof branchCapabilities>
  readonly sourceControlProvider?: string
  readonly contextState?: ContextProviderState
  readonly workspaceBranching?: NonNullable<ExecutionPort['workspaceBranching']>
  readonly workspaceBranchingProvider?: AgentWorkspaceBranchingProvider
  readonly confidentialAttestationVerifier?: NonNullable<
    ExecutionPort['confidentialAttestationVerifier']
  >
}): ExecutionPort {
  const contextState = options.contextState
  const sourceControlProvider = options.sourceControlProvider ?? SOURCE_PROVIDER
  return {
    admissionMode: 'sync',
    capabilities: () => options.capabilities,
    admit(input) {
      const destination = input.contextTransfer !== undefined
      return {
        capabilities: options.capabilities,
        provider: destination ? TARGET_PROVIDER : SOURCE_PROVIDER,
        environmentId: destination
          ? input.contextTransfer?.plan.destination.environmentId
          : 'provider-source-environment',
        providerSessionId: destination
          ? input.contextTransfer?.plan.destination.sessionId
          : SOURCE_SESSION,
        materializationReceipt: { provider: destination ? TARGET_PROVIDER : SOURCE_PROVIDER },
      }
    },
    async *streamTurn(input) {
      if (contextState !== undefined && input.contextTransfer !== undefined)
        contextState.transfers.push(input.contextTransfer)
      if (!input.contextTransfer) {
        yield {
          type: 'braid.execution.observed',
          observation: {
            kind: 'sandbox',
            provider: SOURCE_PROVIDER,
            providerEnvironmentId: 'provider-source-environment',
            lifecycle: 'ready',
            lifecycleMode: 'retained',
            cleanup: 'explicit',
            continuity: 'session',
            location: 'remote',
            createdAt: AT,
            startedAt: AT,
            lastActivityAt: AT,
            observedAt: AT,
            unavailable: [],
          },
          controlRef: exactControl({
            runId: input.runId,
            provider: sourceControlProvider,
            environmentId: 'provider-source-environment',
            sessionId: SOURCE_SESSION,
            executionId: 'provider-source-execution',
          }),
          timestamp: AT,
        }
      }
      yield {
        type: 'final',
        status: 'completed',
        reason: 'completed',
        text: `completed ${input.text}`,
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: `task-${input.runId}`, intent: input.text },
        timestamp: AT,
      }
    },
    ...(contextState === undefined
      ? {}
      : {
          context: {
            async transfer(request: ContextTransferRequest) {
              contextState.transfers.push(request)
              return contextResult(request)
            },
          },
        }),
    ...(options.workspaceBranching === undefined
      ? {}
      : { workspaceBranching: options.workspaceBranching }),
    ...(options.workspaceBranchingProvider === undefined
      ? {}
      : { workspaceBranchingProvider: options.workspaceBranchingProvider }),
    ...(options.confidentialAttestationVerifier === undefined
      ? {}
      : { confidentialAttestationVerifier: options.confidentialAttestationVerifier }),
  }
}

test('cross-runner handoff transfers canonical history and replays after restart', async () => {
  const contextState: ContextProviderState = { transfers: [] }
  const execution = executionFor({
    capabilities: branchCapabilities(),
    contextState,
  })
  const journal = new MemoryJournal(new FixedClock(AT))
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
    journal,
    effectStorage: journal,
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-branch-effects', text: 'source history' }).completion

  const plan = app.conversations.branches.plan({
    operationId: 'op-cross-runner-branch-effects',
    kind: 'cross-runner',
    runner: 'codex',
    destinationProvider: TARGET_PROVIDER,
  })
  assert.equal(plan.allowed, true)
  const portableContextPlan = plan.portableContextPlan
  assert(portableContextPlan)
  const accepted = portableContextPlan.requiresAcceptance
    ? { acceptedDigest: portableContextPlan.digest }
    : {}
  const branch = await app.conversations.branches.execute({
    operationId: 'op-cross-runner-branch-effects',
    kind: 'cross-runner',
    runner: 'codex',
    destinationProvider: TARGET_PROVIDER,
    ...accepted,
    planDigest: plan.digest,
  })

  assert.equal(contextState.transfers.length, 1)
  assert.equal(contextState.transfers[0]?.plan.destination.runner, 'codex')
  assert.equal(branch.id, plan.destinationBranchId)
  assert.notEqual(branch.environmentId, plan.sourceEnvironmentId)
  const handoffEdge = app.state().graphEdges.find((edge) => edge.kind === 'handed_off')
  assert(handoffEdge)
  assert.equal(
    app.state().graphNodes.find((node) => node.id === handoffEdge.destination)?.reference.id,
    branch.id,
  )
  assert.equal(
    app.state().operations.find((operation) => operation.id === 'op-cross-runner-branch-effects')
      ?.status,
    'acknowledged',
  )

  const restarted = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
    journal,
    effectStorage: journal,
  })
  const replay = await restarted.conversations.branches.execute({
    operationId: 'op-cross-runner-branch-effects',
    kind: 'cross-runner',
    runner: 'codex',
    destinationProvider: TARGET_PROVIDER,
    ...accepted,
    planDigest: plan.digest,
  })
  assert.equal(replay.id, branch.id)
  assert.equal(contextState.transfers.length, 1)
  assert.equal(
    restarted.state().branches.filter((candidate) => candidate.id === branch.id).length,
    1,
  )
})

test('cross-runner planning binds the exact destination profile after redaction and overrides', async () => {
  const contextState: ContextProviderState = { transfers: [] }
  const profile = defineAgentProfile({
    name: 'Profile identity test',
    harness: 'pi',
    model: {
      default: 'source-model',
      provider: 'source-model-provider',
      metadata: { apiKey: 'profile-secret', maxTokens: 512 },
    },
  })
  const execution = executionFor({
    capabilities: branchCapabilities(),
    contextState,
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    profile,
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-profile-source', text: 'source history' }).completion

  const plan = app.conversations.branches.plan({
    operationId: 'op-profile-cross-runner',
    kind: 'cross-runner',
    runner: 'codex',
    model: 'target-model',
    destinationProvider: TARGET_PROVIDER,
  })
  assert.equal(plan.allowed, true)
  assert(plan.portableContextPlan)
  const expectedProfile = {
    ...profile,
    harness: 'codex' as const,
    model: {
      default: 'target-model',
      metadata: profile.model?.metadata,
    },
  }
  assert.equal(
    plan.portableContextPlan.destination.profileDigest,
    `sha256:${canonicalAgentProfileDigestHex(expectedProfile)}`,
  )
  assert.notEqual(
    plan.portableContextPlan.destination.profileDigest,
    `sha256:${canonicalAgentProfileDigestHex(app.state().profile)}`,
  )
})

test('fork execution on another branch preserves a live run', async () => {
  const started = deferred()
  const release = deferred()
  const baseExecution = executionFor({ capabilities: branchCapabilities() })
  const execution: ExecutionPort = {
    ...baseExecution,
    async *streamTurn(input) {
      started.resolve()
      await release.promise
      yield {
        type: 'final',
        status: 'completed',
        reason: 'live run completed',
        text: `completed ${input.text}`,
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: `task-${input.runId}`, intent: input.text },
        timestamp: AT,
      }
    },
  }
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  const sourceBranchId = app.state().branchId
  const liveBranch = await app.conversations.branches.create({
    operationId: 'op-create-live-branch',
  })
  const live = app.send({ operationId: 'op-live-branch', text: 'keep this run live' })

  try {
    await started.promise
    assert.equal(liveBranch.id, app.state().branchId)
    assert.equal(app.state().activeRunId, live.runId)

    const plan = app.conversations.branches.plan({
      operationId: 'op-fork-while-live',
      kind: 'conversation',
      branchId: sourceBranchId,
    })
    const fork = await app.conversations.branches.execute({
      operationId: 'op-fork-while-live',
      kind: 'conversation',
      branchId: sourceBranchId,
      planDigest: plan.digest,
    })

    assert.equal(fork.id, plan.destinationBranchId)
    assert.equal(app.state().activeRunId, live.runId)
    assert.equal(app.state().runs.find((run) => run.id === live.runId)?.status, 'streaming')
  } finally {
    release.resolve()
    await live.completion
  }
})

test('workspace fork requires a completed source boundary', async () => {
  const provider = workspaceProvider()
  const started = deferred()
  const release = deferred()
  const workspaceBranchingProvider: AgentWorkspaceBranchingProvider = {
    async forEnvironment(sourceEnvironmentId) {
      return sourceEnvironmentId === 'provider-source-environment' ? provider.branching : null
    },
  }
  const baseExecution = executionFor({
    capabilities: branchCapabilities(true),
    workspaceBranchingProvider,
  })
  const execution: ExecutionPort = {
    ...baseExecution,
    async *streamTurn(input) {
      let first = true
      for await (const event of baseExecution.streamTurn(input)) {
        yield event
        if (first) {
          first = false
          started.resolve()
          await release.promise
        }
      }
    },
  }
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  const live = app.send({ operationId: 'op-live-workspace-boundary', text: 'still running' })
  try {
    await started.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    const plan = app.conversations.branches.plan({
      operationId: 'op-workspace-boundary-required',
      kind: 'workspace',
    })
    assert.equal(plan.allowed, false)
    assert.match(plan.reason ?? '', /retry-safe checkpoint and environment fork support/u)
    assert.equal(provider.state.checkpointRequests.length, 0)
  } finally {
    release.resolve()
    await live.completion
  }
})

test('workspace fork rejects a source control reference from another provider', async () => {
  const provider = workspaceProvider()
  const execution = executionFor({
    capabilities: branchCapabilities(true),
    sourceControlProvider: 'foreign-provider',
    workspaceBranchingProvider: {
      async forEnvironment(sourceEnvironmentId) {
        return sourceEnvironmentId === 'provider-source-environment' ? provider.branching : null
      },
    },
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-provider-mismatch-source', text: 'source' }).completion
  const plan = app.conversations.branches.plan({
    operationId: 'op-provider-mismatch-fork',
    kind: 'workspace',
  })
  assert.equal(plan.allowed, false)
  assert.match(plan.reason ?? '', /retry-safe checkpoint and environment fork support/u)
  assert.equal(provider.state.checkpointRequests.length, 0)
})

test('cross-runner retry reuses the original acceptance timestamp in its request digest', async () => {
  const contextState: ContextProviderState = { transfers: [] }
  let failOnce = true
  const baseExecution = executionFor({
    capabilities: branchCapabilities(),
    contextState,
  })
  const execution: ExecutionPort = {
    ...baseExecution,
    context: {
      async transfer(request) {
        contextState.transfers.push(request)
        if (failOnce) {
          failOnce = false
          return {
            status: 'unknown',
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            message: 'The provider response was lost',
            retryable: true,
          }
        }
        return contextResult(request)
      },
    },
  }
  const journal = new MemoryJournal(new FixedClock(AT))
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
    journal,
    effectStorage: journal,
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-transfer-retry', text: 'source history' }).completion
  const plan = app.conversations.branches.plan({
    operationId: 'op-cross-runner-transfer-retry',
    kind: 'cross-runner',
    runner: 'codex',
    destinationProvider: TARGET_PROVIDER,
  })
  const portableContextPlan = plan.portableContextPlan
  assert(portableContextPlan)
  const accepted = portableContextPlan.requiresAcceptance
    ? { acceptedDigest: portableContextPlan.digest }
    : {}
  const input = {
    operationId: 'op-cross-runner-transfer-retry',
    kind: 'cross-runner' as const,
    runner: 'codex',
    destinationProvider: TARGET_PROVIDER,
    ...accepted,
    planDigest: plan.digest,
  }
  await assert.rejects(() => app.conversations.branches.execute(input), /response was lost/u)

  const restarted = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock('2026-08-29T00:00:00.000Z'),
    journal,
    effectStorage: journal,
  })
  await restarted.conversations.branches.execute(input)

  assert.equal(contextState.transfers.length, 2)
  assert.equal(
    contextState.transfers[0]?.acceptance.acceptedAt,
    contextState.transfers[1]?.acceptance.acceptedAt,
  )
  assert.equal(contextState.transfers[0]?.requestDigest, contextState.transfers[1]?.requestDigest)
})

test('workspace fork uses exact provider operations, isolates destination, and cleans both resources', async () => {
  const provider = workspaceProvider()
  const sourceLookups: string[] = []
  const workspaceBranchingProvider: AgentWorkspaceBranchingProvider = {
    async forEnvironment(sourceEnvironmentId) {
      sourceLookups.push(sourceEnvironmentId)
      return sourceEnvironmentId === 'provider-source-environment' ? provider.branching : null
    },
  }
  const execution = executionFor({
    capabilities: branchCapabilities(true),
    workspaceBranchingProvider,
  })
  const journal = new MemoryJournal(new FixedClock(AT))
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
    journal,
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-workspace-effects', text: 'checkpoint source' })
    .completion
  const plan = app.conversations.branches.plan({
    operationId: 'op-workspace-branch-effects',
    kind: 'workspace',
  })
  assert.equal(plan.allowed, true)
  const branch = await app.conversations.branches.execute({
    operationId: 'op-workspace-branch-effects',
    kind: 'workspace',
    planDigest: plan.digest,
  })
  assert.equal(provider.state.checkpointRequests.length, 1)
  assert.equal(provider.state.forkRequests.length, 1)
  assert.deepEqual(sourceLookups, ['provider-source-environment'])
  assert.notEqual(branch.environmentId, plan.sourceEnvironmentId)
  assert.equal(
    provider.state.forkRequests[0]?.checkpoint.source.environmentId,
    app.state().environments.find((environment) => environment.id === plan.sourceEnvironmentId)
      ?.providerEnvironmentId,
  )
  const checkpoint = app.state().checkpoints[0]
  assert(checkpoint)
  const destination = app
    .state()
    .environments.find((environment) => environment.id === branch.environmentId)
  assert(destination)
  assert.equal(destination.providerEnvironmentId, 'provider-destination-environment')
  assert.notEqual(
    destination.providerEnvironmentId,
    provider.state.forkRequests[0]?.checkpoint.source.environmentId,
  )

  const workspaceReplay = await app.conversations.branches.execute({
    operationId: 'op-workspace-branch-effects',
    kind: 'workspace',
    planDigest: plan.digest,
  })
  assert.equal(workspaceReplay.id, branch.id)
  assert.equal(provider.state.checkpointRequests.length, 1)
  assert.equal(provider.state.forkRequests.length, 1)
  assert.deepEqual(sourceLookups, ['provider-source-environment'])

  const restarted = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
    journal,
  })
  const cleanup = await restarted.conversations.branches.cleanup({
    operationId: 'op-cleanup-workspace-effects',
    checkpointId: String(checkpoint.id),
    environmentId: String(destination.id),
  })
  assert.deepEqual(cleanup, { checkpoint: 'deleted', environment: 'deleted' })
  assert.deepEqual(
    provider.state.cleanupRequests.map(({ kind, targetId }) => ({ kind, targetId })),
    [
      { kind: 'checkpoint', targetId: 'provider-checkpoint-1' },
      { kind: 'fork', targetId: 'provider-destination-environment' },
    ],
  )
  assert.notEqual(
    provider.state.cleanupRequests[0]?.operationId,
    provider.state.cleanupRequests[1]?.operationId,
  )
  assert.equal(
    restarted.state().checkpoints.find((candidate) => candidate.id === checkpoint.id)?.status,
    'deleted',
  )
  assert.equal(
    restarted.state().environments.find((candidate) => candidate.id === destination.id)?.lifecycle,
    'destroyed',
  )

  const replayRestarted = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
    journal,
  })
  const cleanupReplay = await replayRestarted.conversations.branches.cleanup({
    operationId: 'op-cleanup-workspace-effects',
    checkpointId: String(checkpoint.id),
    environmentId: String(destination.id),
  })
  assert.deepEqual(cleanupReplay, cleanup)
  assert.equal(provider.state.cleanupRequests.length, 2)
  assert.deepEqual(sourceLookups, ['provider-source-environment', 'provider-source-environment'])
})

test('confidential workspace fork records verification only after canonical attestation checks', async () => {
  const provider = workspaceProvider()
  const execution = executionFor({
    capabilities: branchCapabilities(true),
    workspaceBranchingProvider: {
      async forEnvironment(sourceEnvironmentId) {
        return sourceEnvironmentId === 'provider-source-environment' ? provider.branching : null
      },
    },
    confidentialAttestationVerifier: (attestation, environment) =>
      attestation.providerKeyId === 'trusted-provider-key' &&
      attestation.providerSignature === 'trusted-provider-signature' &&
      attestation.measurement === `sha256:${'a'.repeat(64)}` &&
      attestation.environmentId === environment.environmentId,
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-confidential-effects', text: 'confidential source' })
    .completion
  const confidential = {
    requested: true as const,
    nonce: 'confidential-nonce',
    policy: 'confidential-policy',
    profileDigest: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
  }
  const planInput = {
    operationId: 'op-confidential-workspace-effects',
    kind: 'workspace' as const,
    confidential,
  }
  const plan = app.conversations.branches.plan(planInput)
  assert.equal(plan.allowed, true)
  assert.equal(plan.confidential?.requested, true)
  const branch = await app.conversations.branches.execute({
    ...planInput,
    planDigest: plan.digest,
  })
  const destination = app
    .state()
    .environments.find((environment) => environment.id === branch.environmentId)
  assert(destination)
  assert.equal(destination.placement.confidentialRequested, true)
  assert.equal(destination.placement.confidentialVerified, true)
  assert.equal(provider.state.forkRequests[0]?.confidential?.requested, true)
})

test('confidential workspace planning stays unavailable without an external verifier', async () => {
  const provider = workspaceProvider()
  const execution = executionFor({
    capabilities: branchCapabilities(true),
    workspaceBranchingProvider: {
      async forEnvironment(sourceEnvironmentId) {
        return sourceEnvironmentId === 'provider-source-environment' ? provider.branching : null
      },
    },
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-confidential-unverified', text: 'source' }).completion
  const plan = app.conversations.branches.plan({
    operationId: 'op-confidential-unverified',
    kind: 'workspace',
    confidential: {
      requested: true,
      nonce: 'confidential-nonce',
      policy: 'confidential-policy',
      profileDigest: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
    },
  })
  assert.equal(plan.allowed, false)
  assert.match(plan.reason ?? '', /confidential placement and attestation verification/u)
})

test('cross-runner planning stays unavailable without a provider transfer method', async () => {
  const execution = executionFor({ capabilities: branchCapabilities() })
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-no-transfer', text: 'source history' }).completion
  const plan = app.conversations.branches.plan({
    operationId: 'op-cross-runner-no-transfer',
    kind: 'cross-runner',
    runner: 'codex',
  })
  assert.equal(plan.allowed, false)
  assert.match(plan.reason ?? '', /context transfer/iu)
})
