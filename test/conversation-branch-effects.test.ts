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
import {
  type ConversationDispatchContext,
  dispatchConversationHeadlessCommand,
  dispatchConversationRunCommand,
} from '../src/adapters/tui/ui-conversation-dispatch.js'
import { createBraidApplication } from '../src/app/composition.js'
import { executeBranchEffect } from '../src/app/conversation-branch-effects.js'
import type { ConversationHost } from '../src/app/conversation-types.js'
import { MemoryJournal } from '../src/app/journal.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { ConnectionRecord, OperationRecord } from '../src/domain/entities.js'
import type { BraidEvent, BraidEventEnvelope } from '../src/domain/events.js'
import { createConnectionId, createOperationId } from '../src/domain/ids.js'
import { replayEvents } from '../src/domain/reducer.js'
import type { BraidState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecutionPort,
  type RunCapabilities,
} from '../src/ports/execution.js'

const AT = '2026-08-28T00:00:00.000Z'
const SOURCE_PROVIDER = 'source-provider'
const TARGET_PROVIDER = 'tangle-sandbox'
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

class CleanupBoundaryCrashJournal extends MemoryJournal {
  #operationId: string | undefined

  crashAfterCleanupProgress(operationId: string): void {
    this.#operationId = operationId
  }

  override append(envelope: BraidEventEnvelope) {
    const result = super.append(envelope)
    const operation =
      envelope.event.kind === 'operation.updated' ? envelope.event.operation : undefined
    if (
      this.#operationId !== undefined &&
      operation?.id === this.#operationId &&
      operation.result?.environment === 'deleted'
    ) {
      this.#operationId = undefined
      throw new Error('simulated crash between fork and checkpoint cleanup')
    }
    return result
  }
}

function appendSeededEvent(
  journal: MemoryJournal,
  state: BraidState,
  event: BraidEvent,
): BraidState {
  const envelope = journal.envelope(state, event)
  const result = journal.append(envelope)
  assert.equal(result.appended, true)
  return replayEvents(state, [envelope])
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

function branchCapabilities(workspace = false, confidential = false): RunCapabilities {
  return {
    ...DEFAULT_RUN_CAPABILITIES,
    streaming: { ...DEFAULT_RUN_CAPABILITIES.streaming, replay: true },
    sessions: { continue: true, messages: true },
    events: { stableIdentity: true, sequence: true, cursor: true },
    environment: {
      branching: {
        checkpoint: workspace,
        fork: workspace,
        confidential,
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
    environmentId: plan.destination.environmentId ?? 'provider-context-destination',
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

function workspaceProvider(
  options: {
    readonly beforeFork?: (request: WorkspaceForkRequest) => void
    readonly requireForkBeforeCheckpoint?: boolean
  } = {},
): {
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
      if (options.requireForkBeforeCheckpoint && state.forks.size > 0) {
        return {
          operationId: request.operationId,
          kind: 'checkpoint' as const,
          targetId: request.targetId,
          provider: request.provider,
          requestDigest: request.requestDigest,
          status: 'in_use' as const,
          blockingTargetIds: [...state.forks.values()].map(
            (fork) => fork.environment.environmentId,
          ),
          message: 'Checkpoint is still referenced by a fork',
        }
      }
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
      options.beforeFork?.(request)
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
              tee: confidential.tee,
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
      for (const [key, fork] of state.forks) {
        if (fork.environment.environmentId === request.targetId) state.forks.delete(key)
      }
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
      const provider = destination
        ? (input.contextTransferReceipt?.provider ??
          input.contextTransfer?.plan.destination.provider ??
          TARGET_PROVIDER)
        : SOURCE_PROVIDER
      return {
        capabilities: options.capabilities,
        provider,
        environmentId: destination
          ? (input.contextTransferReceipt?.environmentId ??
            input.contextTransfer?.plan.destination.environmentId)
          : 'provider-source-environment',
        providerSessionId: destination
          ? input.contextTransfer?.plan.destination.sessionId
          : SOURCE_SESSION,
        materializationReceipt: { provider },
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

function stateWithRunCapabilities(
  state: BraidState,
  runId: string,
  update: (capabilities: RunCapabilities) => RunCapabilities,
): BraidState {
  return {
    ...state,
    runs: state.runs.map((run) =>
      run.id === runId ? { ...run, capabilities: update(run.capabilities) } : run,
    ),
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

  const plan = await app.conversations.branches.plan({
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

test('same-runner handoff binds the selected destination connection through restart', async () => {
  const contextState: ContextProviderState = { transfers: [] }
  const journal = new MemoryJournal(new FixedClock(AT))
  const routeTargets: (string | undefined)[] = []
  const execution = executionFor({ capabilities: branchCapabilities(), contextState })
  const transfer = execution.context?.transfer
  assert(transfer)
  const routedExecution = {
    ...execution,
    context: {
      async transfer(request: ContextTransferRequest, target?: { readonly connectionId: string }) {
        routeTargets.push(target?.connectionId)
        return transfer(request)
      },
    },
  }
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution: routedExecution,
    clock: new FixedClock(AT),
    journal,
    effectStorage: journal,
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-connection-source', text: 'source history' }).completion
  const sourceBranch = structuredClone(app.state().branches[0])
  assert(sourceBranch)
  const destination: ConnectionRecord = {
    ...sourceConnection(),
    id: createConnectionId('connection-branch-effects-destination'),
    kind: 'cli-bridge',
    name: 'destination connection',
  }
  await app.configuration.upsertConnection({
    connection: destination,
    operation: {
      id: createOperationId('operation-register-destination'),
      kind: 'connection-change',
      requestDigest: canonicalDigest(destination),
      status: 'acknowledged',
      createdAt: AT,
      updatedAt: AT,
      acknowledgedAt: AT,
    },
  })
  const input = {
    operationId: 'op-same-runner-connection',
    connectionId: destination.id,
    runner: app.state().profile.harness ?? 'pi',
  }
  const plan = await app.conversations.branches.plan(input)
  assert.equal(plan.kind, 'cross-runner')
  assert.equal(plan.destinationConnectionId, destination.id)
  assert.equal(plan.destinationConnectionDigest, canonicalDigest(destination))
  assert.equal(plan.portableContextPlan?.destination.provider, destination.kind)
  const branch = await app.conversations.branches.execute({ ...input, planDigest: plan.digest })
  assert.equal(branch.connectionId, destination.id)
  assert.equal(
    app.state().environments.find((environment) => environment.id === branch.environmentId)
      ?.connectionId,
    destination.id,
  )
  assert.deepEqual(routeTargets, [destination.id])
  const restarted = createBraidApplication({
    fixture: 'deterministic',
    execution: routedExecution,
    clock: new FixedClock(AT),
    journal,
    effectStorage: journal,
  })
  const replay = await restarted.conversations.branches.execute({
    ...input,
    planDigest: plan.digest,
  })
  assert.equal(replay.connectionId, destination.id)
  assert.equal(replay.id, branch.id)
  assert.equal(contextState.transfers.length, 1)
  assert.deepEqual(
    restarted.state().branches.find((candidate) => candidate.id === sourceBranch.id),
    sourceBranch,
  )
  assert.equal(restarted.state().selectedConnectionId, sourceConnection().id)
})

test('handoff rejects a removed or changed destination before provider transfer', async () => {
  const contextState: ContextProviderState = { transfers: [] }
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution: executionFor({ capabilities: branchCapabilities(), contextState }),
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-destination-change-source', text: 'source history' }).completion
  const connection = sourceConnection()
  const input = {
    operationId: 'op-destination-change-handoff',
    connectionId: connection.id,
    runner: 'codex',
  }
  const plan = await app.conversations.branches.plan(input)
  await app.configuration.upsertConnection({
    connection: { ...connection, endpoint: 'http://127.0.0.1:9999' },
    operation: {
      id: createOperationId('operation-change-destination'),
      kind: 'connection-change',
      requestDigest: canonicalDigest({ endpoint: 'http://127.0.0.1:9999' }),
      status: 'acknowledged',
      createdAt: AT,
      updatedAt: AT,
      acknowledgedAt: AT,
    },
  })
  await assert.rejects(
    () => app.conversations.branches.execute({ ...input, planDigest: plan.digest }),
    /accepted fork plan no longer matches/,
  )
  await assert.rejects(
    () => app.conversations.branches.plan({ ...input, connectionId: 'connection-removed' }),
    /destination connection does not exist/,
  )
  await assert.rejects(
    () => app.conversations.branches.plan({ ...input, destinationProvider: 'cli-bridge' }),
    /provider does not match/,
  )
  assert.equal(contextState.transfers.length, 0)
})

test('handoff inherits the branch connection and accepts the exact CLI host workspace through restart', async () => {
  const contextState: ContextProviderState = { transfers: [] }
  const journal = new MemoryJournal(new FixedClock(AT))
  const execution = executionFor({ capabilities: branchCapabilities(), contextState })
  const targets: (string | undefined)[] = []
  const inputs: Parameters<NonNullable<ExecutionPort['admit']>>[0][] = []
  const transfer = execution.context?.transfer
  assert(transfer)
  const routedExecution: ExecutionPort = {
    ...execution,
    admit(input) {
      inputs.push(input)
      return execution.admit!(input)
    },
    context: {
      async transfer(request, target) {
        targets.push(target?.connectionId)
        return transfer(request, target)
      },
    },
  }
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution: routedExecution,
    clock: new FixedClock(AT),
    journal,
    effectStorage: journal,
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-inherit-account-source', text: 'source history' }).completion
  const destination: ConnectionRecord = {
    ...sourceConnection(),
    id: createConnectionId('connection-inherited-cli'),
    kind: 'cli-bridge',
    name: 'inherited CLI account',
  }
  await app.configuration.upsertConnection({
    connection: destination,
    operation: {
      id: createOperationId('operation-register-inherited-cli'),
      kind: 'connection-change',
      requestDigest: canonicalDigest(destination),
      status: 'acknowledged',
      createdAt: AT,
      updatedAt: AT,
      acknowledgedAt: AT,
    },
  })
  const child = await app.conversations.branches.create({
    operationId: 'op-inherit-account-child',
    connectionId: destination.id,
  })
  await app.send({
    operationId: 'op-inherit-account-child-turn',
    branchId: child.id,
    text: 'child history',
  }).completion
  const input = {
    operationId: 'op-inherit-account-handoff',
    branchId: child.id,
    runner: 'codex',
    text: 'Continue here',
  }
  const plan = await app.conversations.branches.plan(input)
  assert.equal(app.state().selectedConnectionId, sourceConnection().id)
  assert.equal(plan.destinationConnectionId, destination.id)
  assert.equal(plan.portableContextPlan?.destination.provider, 'cli-bridge')
  assert.deepEqual(plan.destinationWorkspaceRequest, { cwd: { base: 'host', path: '/workspace' } })
  const branch = await app.conversations.branches.execute({ ...input, planDigest: plan.digest })
  assert.equal(branch.connectionId, destination.id)
  assert.deepEqual(targets, [destination.id])
  assert.deepEqual(contextState.transfers[0]?.workspace, plan.destinationWorkspaceRequest)
  const first = inputs.find((candidate) => candidate.contextTransfer !== undefined)
  assert(first)
  assert.equal(first.connectionId, destination.id)
  assert.deepEqual(first.workspaceRequest, plan.destinationWorkspaceRequest)
  assert.equal(first.workspaceRoot, '/workspace')
  const restarted = createBraidApplication({
    fixture: 'deterministic',
    execution: routedExecution,
    clock: new FixedClock(AT),
    journal,
    effectStorage: journal,
  })
  const replay = await restarted.conversations.branches.execute({
    ...input,
    planDigest: plan.digest,
  })
  assert.equal(replay.id, branch.id)
  assert.equal(replay.connectionId, destination.id)
  assert.deepEqual(targets, [destination.id])
})

test('handoff preview refuses an unsupported destination without admission effects', async () => {
  const contextState: ContextProviderState = { transfers: [] }
  const execution = executionFor({ capabilities: branchCapabilities(), contextState })
  const app = createBraidApplication({
    fixture: 'deterministic',
    clock: new FixedClock(AT),
    execution: {
      ...execution,
      context: {
        ...execution.context,
        async supports() {
          return false
        },
      },
    },
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-preflight-source', text: 'source history' }).completion
  const before = app.state()
  const input = {
    operationId: 'op-preflight-refusal',
    connectionId: sourceConnection().id,
    runner: 'codex',
  }
  const plan = await app.conversations.branches.plan(input)
  assert.equal(plan.allowed, false)
  assert.equal(plan.environment, 'unavailable')
  assert.match(plan.reason ?? '', /does not report retry-safe/)
  assert.deepEqual(app.state(), before)
  await assert.rejects(
    () => app.conversations.branches.execute({ ...input, planDigest: plan.digest }),
    /does not report retry-safe/,
  )
  assert.equal(contextState.transfers.length, 0)
  assert.equal(app.state().branches.length, before.branches.length)
})

test('handoff preflight detects destination changes while capabilities are being read', async () => {
  const reading = deferred()
  const finish = deferred()
  const contextState: ContextProviderState = { transfers: [] }
  const execution = executionFor({ capabilities: branchCapabilities(), contextState })
  const app = createBraidApplication({
    fixture: 'deterministic',
    clock: new FixedClock(AT),
    execution: {
      ...execution,
      context: {
        ...execution.context,
        async supports() {
          reading.resolve()
          await finish.promise
          return true
        },
      },
    },
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-preflight-race-source', text: 'source history' }).completion
  const connection = sourceConnection()
  const pending = app.conversations.branches.plan({
    operationId: 'op-preflight-race',
    connectionId: connection.id,
    runner: 'codex',
  })
  await reading.promise
  await app.configuration.upsertConnection({
    connection: { ...connection, endpoint: 'http://127.0.0.1:9999' },
    operation: {
      id: createOperationId('operation-preflight-change'),
      kind: 'connection-change',
      requestDigest: canonicalDigest({ endpoint: 'http://127.0.0.1:9999' }),
      status: 'acknowledged',
      createdAt: AT,
      updatedAt: AT,
      acknowledgedAt: AT,
    },
  })
  finish.resolve()
  await assert.rejects(pending, /changed during capability preflight/)
  assert.equal(contextState.transfers.length, 0)
})

test('cross-runner planning resolves a completed run inherited by a child branch', async () => {
  const contextState: ContextProviderState = { transfers: [] }
  const execution = executionFor({
    capabilities: branchCapabilities(),
    contextState,
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  const source = await app.send({ operationId: 'op-inherited-source', text: 'source history' })
    .completion
  const sourceRun = source.runs.find((run) => run.operationId === 'op-inherited-source')
  assert(sourceRun)
  const boundary = app.state().messages.find((message) => message.runId === sourceRun.id)
  assert(boundary)
  const child = await app.conversations.branches.create({
    operationId: 'op-inherited-child',
    throughMessageId: boundary.id,
  })

  const plan = await app.conversations.branches.plan({
    operationId: 'op-inherited-cross-runner',
    kind: 'cross-runner',
    branchId: child.id,
    runner: 'codex',
    destinationProvider: TARGET_PROVIDER,
  })

  assert.equal(plan.allowed, true)
  assert.equal(plan.sourceRunId, sourceRun.id)
  assert.equal(plan.sourceEnvironmentId, sourceRun.environmentId)
  assert.equal(plan.portableContextPlan?.source.source.runId, sourceRun.id)
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

  const plan = await app.conversations.branches.plan({
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

    const plan = await app.conversations.branches.plan({
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
    const plan = await app.conversations.branches.plan({
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
  const plan = await app.conversations.branches.plan({
    operationId: 'op-provider-mismatch-fork',
    kind: 'workspace',
  })
  assert.equal(plan.allowed, false)
  assert.match(plan.reason ?? '', /retry-safe checkpoint and environment fork support/u)
  assert.equal(provider.state.checkpointRequests.length, 0)
})

test('cross-runner retry reuses the original acceptance timestamp in its request digest', async () => {
  const contextState: ContextProviderState = { transfers: [] }
  const lookups: ContextTransferRequest[] = []
  let failOnce = true
  const baseExecution = executionFor({
    capabilities: branchCapabilities(),
    contextState,
  })
  const execution: ExecutionPort = {
    ...baseExecution,
    context: {
      async lookup(request) {
        lookups.push(request)
        if (failOnce) return undefined
        return {
          status: 'unknown',
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          message: 'The original admission is pending',
          retryable: true,
        }
      },
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
  const plan = await app.conversations.branches.plan({
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
  assert.equal(lookups.length, 2)
  assert.equal(lookups[0]?.operationId, lookups[1]?.operationId)
  assert.equal(lookups[0]?.requestDigest, lookups[1]?.requestDigest)
  assert.equal(
    contextState.transfers[0]?.acceptance.acceptedAt,
    contextState.transfers[1]?.acceptance.acceptedAt,
  )
  assert.equal(contextState.transfers[0]?.requestDigest, contextState.transfers[1]?.requestDigest)
})

test('pending handoff recovers its original receipt after fresh transfer support disappears', async () => {
  const contextState: ContextProviderState = { transfers: [] }
  const lookups: ContextTransferRequest[] = []
  let freshSupported = true
  let capabilityReads = 0
  let acceptedReceipt: ContextTransferResult | undefined
  const baseExecution = executionFor({ capabilities: branchCapabilities(), contextState })
  const execution: ExecutionPort = {
    ...baseExecution,
    context: {
      async supports() {
        capabilityReads += 1
        return freshSupported
      },
      async lookup(request) {
        lookups.push(request)
        return acceptedReceipt
      },
      async transfer(request) {
        contextState.transfers.push(request)
        acceptedReceipt = contextResult(request)
        return {
          status: 'unknown',
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          message: 'The acceptance acknowledgement was lost',
          retryable: true,
        }
      },
    },
  }
  const journal = new MemoryJournal(new FixedClock(AT))
  const app = createBraidApplication({
    fixture: 'deterministic', execution, clock: new FixedClock(AT), journal, effectStorage: journal,
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-historical-recovery', text: 'source history' }).completion
  const planInput = {
    operationId: 'op-historical-recovery', kind: 'cross-runner' as const,
    runner: 'codex', destinationProvider: TARGET_PROVIDER,
  }
  const plan = await app.conversations.branches.plan(planInput)
  const portablePlan = plan.portableContextPlan
  assert(portablePlan)
  assert.equal(plan.allowed, true)
  const input = {
    ...planInput, planDigest: plan.digest,
    ...(portablePlan.requiresAcceptance ? { acceptedDigest: portablePlan.digest } : {}),
  }
  await assert.rejects(() => app.conversations.branches.execute(input), /acknowledgement was lost/)
  assert.equal(app.state().operations.find((operation) => operation.id === input.operationId)?.status, 'pending')
  freshSupported = false
  const readsBeforeRecovery = capabilityReads
  const restarted = createBraidApplication({
    fixture: 'deterministic', execution, clock: new FixedClock('2026-08-29T00:00:00.000Z'),
    journal, effectStorage: journal,
  })
  await assert.rejects(
    () => restarted.conversations.branches.execute({ ...input, text: 'changed-request' }),
    /accepted fork plan no longer matches/,
  )
  await assert.rejects(
    () => restarted.conversations.branches.execute({ ...input, acceptedDigest: 'changed-acceptance' }),
    portablePlan.requiresAcceptance ? /requires explicit acceptance/ : /already used with different input/,
  )
  assert.equal(lookups.length, 1)
  const recovered = await restarted.conversations.branches.execute(input)
  assert.equal(recovered.id, plan.destinationBranchId)
  assert.equal(contextState.transfers.length, 1)
  assert.equal(lookups.length, 2)
  assert.deepEqual(lookups[1], lookups[0])
  assert.equal(capabilityReads, readsBeforeRecovery)
  const operation = restarted.state().operations.find((candidate) => candidate.id === input.operationId)
  assert.equal(operation?.status, 'acknowledged')
  assert.equal(operation?.result?.planDigest, plan.digest)
  assert.equal((await restarted.conversations.branches.execute(input)).id, recovered.id)
  assert.equal(lookups.length, 2)
  assert.equal(contextState.transfers.length, 1)
  const newPlan = await restarted.conversations.branches.plan({
    ...planInput, operationId: 'op-new-unsupported-handoff', branchId: plan.sourceBranchId,
  })
  assert.equal(newPlan.allowed, false)
  await assert.rejects(
    () => restarted.conversations.branches.execute({
      ...planInput, operationId: newPlan.operationId, branchId: plan.sourceBranchId,
      planDigest: newPlan.digest,
    }),
    /does not report retry-safe/,
  )
  assert.equal(contextState.transfers.length, 1)
})

for (const scenario of [
  { status: 'transport_failure', retryable: true, differentRequest: false },
  { status: 'unknown', retryable: false, differentRequest: false },
  { status: 'unknown', retryable: true, differentRequest: true },
] as const) {
  test(`handoff preserves ${scenario.status} lookup with retryable=${scenario.retryable} and differentRequest=${scenario.differentRequest}`, async () => {
    const contextState: ContextProviderState = { transfers: [] }
    const baseExecution = executionFor({ capabilities: branchCapabilities(), contextState })
    const transfer = baseExecution.context?.transfer
    assert(transfer)
    const execution: ExecutionPort = {
      ...baseExecution,
      context: {
        async lookup(request) {
          return {
            status: scenario.status,
            operationId: request.operationId,
            requestDigest: scenario.differentRequest ? `sha256:${'f'.repeat(64)}` : request.requestDigest,
            message: 'Preserve the original lookup outcome',
            retryable: scenario.retryable,
          }
        },
        transfer,
      },
    }
    const app = createBraidApplication({ fixture: 'deterministic', execution, clock: new FixedClock(AT) })
    await prepareSource(app)
    await app.send({ operationId: 'op-source-preserved-lookup', text: 'source history' }).completion
    const plan = await app.conversations.branches.plan({
      operationId: 'op-preserved-lookup',
      kind: 'cross-runner',
      runner: 'codex',
      destinationProvider: TARGET_PROVIDER,
    })
    const portableContextPlan = plan.portableContextPlan
    assert(portableContextPlan)
    await assert.rejects(() => app.conversations.branches.execute({
      operationId: 'op-preserved-lookup',
      kind: 'cross-runner',
      runner: 'codex',
      destinationProvider: TARGET_PROVIDER,
      planDigest: plan.digest,
      ...(portableContextPlan.requiresAcceptance
        ? { acceptedDigest: portableContextPlan.digest }
        : {}),
    }))
    assert.equal(contextState.transfers.length, 0)
  })
}

test('workspace fork uses exact provider operations, isolates destination, and cleans both resources', async () => {
  let app: ReturnType<typeof createBraidApplication> | undefined
  let operationAtFork:
    | ReturnType<ReturnType<typeof createBraidApplication>['state']>['operations'][number]
    | undefined
  const provider = workspaceProvider({
    requireForkBeforeCheckpoint: true,
    beforeFork: () => {
      operationAtFork = app
        ?.state()
        .operations.find((operation) => operation.id === 'op-workspace-branch-effects')
    },
  })
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
  app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
    journal,
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-workspace-effects', text: 'checkpoint source' })
    .completion
  const otherConnection = {
    ...sourceConnection(),
    id: createConnectionId('connection-other-workspace-account'),
  }
  await app.configuration.upsertConnection({
    connection: otherConnection,
    operation: {
      id: createOperationId('operation-register-other-workspace-account'),
      kind: 'connection-change',
      requestDigest: canonicalDigest(otherConnection),
      status: 'acknowledged',
      createdAt: AT,
      updatedAt: AT,
      acknowledgedAt: AT,
    },
  })
  await assert.rejects(
    () =>
      app!.conversations.branches.plan({
        operationId: 'op-wrong-workspace-account',
        kind: 'workspace',
        connectionId: otherConnection.id,
      }),
    /must keep the source run connection/u,
  )
  assert.deepEqual(provider.state.checkpointRequests, [])
  assert.deepEqual(provider.state.forkRequests, [])
  const plan = await app.conversations.branches.plan({
    operationId: 'op-workspace-branch-effects',
    kind: 'workspace',
  })
  assert.equal(plan.allowed, true)
  const branch = await app.conversations.branches.execute({
    operationId: 'op-workspace-branch-effects',
    kind: 'workspace',
    planDigest: plan.digest,
  })
  assert.equal(operationAtFork?.status, 'pending')
  assert.deepEqual(operationAtFork?.result, {
    checkpointId: String(app.state().checkpoints[0]?.id),
    providerCheckpointId: 'provider-checkpoint-1',
    forkRequestDigest: provider.state.forkRequests[0]?.requestDigest,
  })
  assert.equal(provider.state.checkpointRequests.length, 1)
  assert.equal(provider.state.forkRequests.length, 1)
  const acknowledged = app
    .state()
    .operations.find((operation) => operation.id === 'op-workspace-branch-effects')
  assert.equal(acknowledged?.status, 'acknowledged')
  assert.equal(
    acknowledged?.result?.forkRequestDigest,
    provider.state.forkRequests[0]?.requestDigest,
  )
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
      { kind: 'fork', targetId: 'provider-destination-environment' },
      { kind: 'checkpoint', targetId: 'provider-checkpoint-1' },
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

test('workspace cleanup restarts between fork and checkpoint cleanup without repeating a terminal result', async () => {
  const operationId = createOperationId('op-cleanup-workspace-restart-boundary')
  const provider = workspaceProvider({ requireForkBeforeCheckpoint: true })
  const execution = executionFor({
    capabilities: branchCapabilities(true),
    workspaceBranchingProvider: {
      async forEnvironment(sourceEnvironmentId) {
        return sourceEnvironmentId === 'provider-source-environment' ? provider.branching : null
      },
    },
  })
  const journal = new CleanupBoundaryCrashJournal(new FixedClock(AT))
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
    journal,
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-workspace-restart', text: 'checkpoint source' })
    .completion
  const plan = await app.conversations.branches.plan({
    operationId: 'op-workspace-restart-fork',
    kind: 'workspace',
  })
  const branch = await app.conversations.branches.execute({
    operationId: 'op-workspace-restart-fork',
    kind: 'workspace',
    planDigest: plan.digest,
  })
  const checkpoint = app.state().checkpoints[0]
  assert(checkpoint)
  const destination = app
    .state()
    .environments.find((environment) => environment.id === branch.environmentId)
  assert(destination)
  assert.equal(destination.providerEnvironmentId, 'provider-destination-environment')
  const cleanupDigest = canonicalDigest({
    command: 'cleanup_workspace_fork',
    operationId,
    checkpointId: checkpoint.id,
    providerCheckpointId: 'provider-checkpoint-1',
    environmentId: destination.id,
    providerEnvironmentId: destination.providerEnvironmentId,
  })
  const cleanupOperation: OperationRecord = {
    id: operationId,
    kind: 'conversation-fork',
    requestDigest: cleanupDigest,
    status: 'pending',
    createdAt: AT,
    updatedAt: AT,
  }
  let seededState = app.state()
  seededState = appendSeededEvent(journal, seededState, {
    kind: 'operation.requested',
    operation: cleanupOperation,
  })
  seededState = appendSeededEvent(journal, seededState, {
    kind: 'checkpoint.upserted',
    checkpoint: { ...checkpoint, status: 'deleted' },
  })
  appendSeededEvent(journal, seededState, {
    kind: 'operation.updated',
    operation: {
      ...cleanupOperation,
      result: { checkpoint: 'deleted', environment: 'not_requested' },
      updatedAt: AT,
    },
  })

  journal.crashAfterCleanupProgress(String(operationId))
  const crashed = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
    journal,
  })
  await assert.rejects(
    () =>
      crashed.conversations.branches.cleanup({
        operationId: String(operationId),
        checkpointId: String(checkpoint.id),
        environmentId: String(destination.id),
      }),
    /simulated crash between fork and checkpoint cleanup/u,
  )
  const progress = journal
    .all()
    .map(({ event }) => event)
    .filter(
      (event) => event.kind === 'operation.updated' && event.operation.id === String(operationId),
    )
    .at(-1)
  assert(progress)
  assert.equal(progress.kind, 'operation.updated')
  assert.deepEqual(progress.operation.result, {
    checkpoint: 'deleted',
    environment: 'deleted',
  })
  assert.deepEqual(
    crashed.state().operations.find((operation) => operation.id === operationId)?.result,
    {
      checkpoint: 'deleted',
      environment: 'not_requested',
    },
  )

  const restarted = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
    journal,
  })
  const cleanup = await restarted.conversations.branches.cleanup({
    operationId: String(operationId),
    checkpointId: String(checkpoint.id),
    environmentId: String(destination.id),
  })
  assert.deepEqual(cleanup, { checkpoint: 'deleted', environment: 'deleted' })
  assert.equal(provider.state.cleanupRequests.length, 1)
  assert.deepEqual(
    provider.state.cleanupRequests.map(({ kind, targetId }) => ({ kind, targetId })),
    [{ kind: 'fork', targetId: 'provider-destination-environment' }],
  )
  assert.equal(typeof provider.state.cleanupRequests[0]?.operationId, 'string')
  assert.notEqual(provider.state.cleanupRequests[0]?.operationId, String(operationId))
  assert.equal(
    restarted.state().operations.find((operation) => operation.id === operationId)?.status,
    'acknowledged',
  )
})

test('confidential workspace fork records verification only after canonical attestation checks', async () => {
  const provider = workspaceProvider()
  const execution = executionFor({
    capabilities: branchCapabilities(true, true),
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
    tee: 'nitro' as const,
    nonce: 'confidential-nonce',
    policy: 'confidential-policy',
    profileDigest: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
  }
  const planInput = {
    operationId: 'op-confidential-workspace-effects',
    kind: 'workspace' as const,
    confidential,
  }
  const plan = await app.conversations.branches.plan(planInput)
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
  assert.equal(provider.state.forkRequests[0]?.confidential?.tee, 'nitro')
})

test('TUI and headless fork surfaces preserve the canonical confidential request through execution', async () => {
  const provider = workspaceProvider()
  const confidential = {
    requested: true as const,
    tee: 'nitro',
    nonce: 'surface-confidential-nonce',
    policy: 'surface-confidential-policy',
    profileDigest: `sha256:${'c'.repeat(64)}` as `sha256:${string}`,
  }
  const execution = executionFor({
    capabilities: branchCapabilities(true, true),
    workspaceBranchingProvider: {
      async forEnvironment(sourceEnvironmentId) {
        return sourceEnvironmentId === 'provider-source-environment' ? provider.branching : null
      },
    },
    confidentialAttestationVerifier: () => true,
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-confidential-surfaces', text: 'source' }).completion
  let preview: Parameters<ConversationDispatchContext['setForkPreview']>[0] | undefined
  const context = {
    app,
    view: () => ({}) as never,
    setNotice: () => undefined,
    setForkPreview: (value: Parameters<ConversationDispatchContext['setForkPreview']>[0]) => {
      preview = value
    },
  } satisfies ConversationDispatchContext

  const tuiResult = await dispatchConversationRunCommand(
    {
      type: 'run-command',
      command: 'fork',
      operationId: 'op-confidential-surface-tui',
      args: ['--workspace', '--confidential', JSON.stringify(confidential), 'follow-up', 'message'],
    },
    context,
  )
  assert.equal(tuiResult?.kind, 'accepted')
  assert.deepEqual(preview?.plan?.confidential, confidential)
  assert.equal(preview?.plan?.text, 'follow-up message')
  assert.equal(Object.isFrozen(preview?.execution), true)
  assert.deepEqual(preview?.execution?.params?.confidential, confidential)
  assert.equal(Object.isFrozen(preview?.execution?.params), true)
  const serializedPreview = JSON.stringify(preview)
  assert.doesNotMatch(serializedPreview, /surface-confidential-nonce|surface-confidential-policy/u)
  assert.doesNotMatch(serializedPreview, /sha256:c{64}/u)
  assert.doesNotMatch(serializedPreview, /planDigest/u)

  const headlessResult = await dispatchConversationHeadlessCommand(
    {
      type: 'headless-command',
      command: 'plan_fork',
      operationId: 'op-confidential-surface-headless',
      params: { workspace: true, confidential },
    },
    context,
  )
  assert.equal(headlessResult?.kind, 'accepted')
  assert(headlessResult?.kind === 'accepted')
  const plan = headlessResult.data
  assert(plan && typeof plan === 'object' && 'digest' in plan)
  const planDigest = plan.digest
  assert.equal(typeof planDigest, 'string')

  const executeResult = await dispatchConversationHeadlessCommand(
    {
      type: 'headless-command',
      command: 'execute_fork',
      operationId: 'op-confidential-surface-headless',
      params: { planDigest, workspace: true, confidential },
    },
    context,
  )
  assert.equal(executeResult?.kind, 'accepted')
  assert.deepEqual(provider.state.forkRequests[0]?.confidential, confidential)
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
  const plan = await app.conversations.branches.plan({
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

test('confidential workspace planning stays unavailable when branching lacks confidential support', async () => {
  const provider = workspaceProvider()
  let providerFactoryCalls = 0
  const execution = executionFor({
    capabilities: branchCapabilities(true),
    workspaceBranchingProvider: {
      async forEnvironment(sourceEnvironmentId) {
        providerFactoryCalls += 1
        return sourceEnvironmentId === 'provider-source-environment' ? provider.branching : null
      },
    },
    confidentialAttestationVerifier: () => true,
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-confidential-capability', text: 'source' }).completion
  const plan = await app.conversations.branches.plan({
    operationId: 'op-confidential-capability',
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
  const beforeState = app.state()
  const beforeStateDigest = canonicalDigest(beforeState)
  await assert.rejects(
    () =>
      app.conversations.branches.execute({
        operationId: 'op-confidential-capability',
        kind: 'workspace',
        confidential: {
          requested: true,
          nonce: 'confidential-nonce',
          policy: 'confidential-policy',
          profileDigest: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
        },
        planDigest: plan.digest,
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: unknown }).code === 'CAPABILITY_UNAVAILABLE',
  )
  const afterState = app.state()
  assert.deepEqual(afterState, beforeState)
  assert.equal(canonicalDigest(afterState), beforeStateDigest)
  assert.equal(provider.state.checkpointRequests.length, 0)
  assert.equal(provider.state.forkRequests.length, 0)
  assert.equal(providerFactoryCalls, 0)
  assert.notEqual(
    canonicalDigest({
      ...afterState,
      effects: [...afterState.effects, { id: 'effect-digest-sentinel' }],
    }),
    beforeStateDigest,
  )
})

test('confidential workspace execution rechecks branching, environment, and verifier capabilities', async () => {
  const provider = workspaceProvider()
  const verifier: NonNullable<ExecutionPort['confidentialAttestationVerifier']> = () => true
  let verifierAvailable = true
  const execution = {
    ...executionFor({
      capabilities: branchCapabilities(true, true),
      workspaceBranchingProvider: {
        async forEnvironment(sourceEnvironmentId) {
          return sourceEnvironmentId === 'provider-source-environment' ? provider.branching : null
        },
      },
      confidentialAttestationVerifier: verifier,
    }),
    get confidentialAttestationVerifier() {
      return verifierAvailable ? verifier : undefined
    },
  } as unknown as ExecutionPort
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-confidential-execution', text: 'source' }).completion
  const planInput = {
    operationId: 'op-confidential-execution',
    kind: 'workspace' as const,
    confidential: {
      requested: true as const,
      nonce: 'confidential-nonce',
      policy: 'confidential-policy',
      profileDigest: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
    },
  }
  const plan = await app.conversations.branches.plan(planInput)
  assert.equal(plan.allowed, true)
  assert(plan.sourceRunId)

  const executeWithState = async (state: BraidState): Promise<void> => {
    const host: ConversationHost = {
      state: () => state,
      now: () => AT,
      profile: () => state.profile,
      execution,
      commit: async () => undefined,
    }
    await assert.rejects(
      () =>
        executeBranchEffect(host, { ...planInput, planDigest: plan.digest }, plan, async () => {
          throw new Error('confidential execution must not create a branch')
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          'The selected run does not expose confidential placement and attestation verification',
    )
  }

  const originalState = app.state()
  await executeWithState(
    stateWithRunCapabilities(originalState, plan.sourceRunId, (capabilities) => {
      const environment = capabilities.environment
      assert(environment)
      return {
        ...capabilities,
        environment: {
          ...environment,
          branching: { ...environment.branching, confidential: false },
        },
      }
    }),
  )
  await executeWithState(
    stateWithRunCapabilities(originalState, plan.sourceRunId, (capabilities) => {
      const environment = capabilities.environment
      assert(environment)
      return {
        ...capabilities,
        environment: { ...environment, confidential: false },
      }
    }),
  )
  verifierAvailable = false
  await executeWithState(originalState)
  assert.equal(provider.state.checkpointRequests.length, 0)
  assert.equal(provider.state.forkRequests.length, 0)
})

test('ordinary workspace planning remains available without confidential branching support', async () => {
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
  await app.send({ operationId: 'op-source-ordinary-capability', text: 'source' }).completion
  const plan = await app.conversations.branches.plan({
    operationId: 'op-ordinary-capability',
    kind: 'workspace',
  })
  assert.equal(plan.allowed, true)
})

test('confidential placement cannot be downgraded to a conversation or cross-runner fork', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', clock: new FixedClock(AT) })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-confidential-kind', text: 'source' }).completion
  const confidential = {
    requested: true as const,
    nonce: 'confidential-nonce',
    policy: 'confidential-policy',
    profileDigest: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
  }
  for (const kind of ['conversation', 'cross-runner'] as const) {
    await assert.rejects(
      () =>
        app.conversations.branches.plan({
          operationId: `op-confidential-kind-${kind}`,
          kind,
          confidential,
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'Confidential placement requires a workspace fork',
    )
  }
})

test('confidential placement planning rejects requests that fail the Interface 2.3 schema', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', clock: new FixedClock(AT) })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-confidential-schema', text: 'source' }).completion
  await assert.rejects(
    () =>
      app.conversations.branches.plan({
        operationId: 'op-confidential-schema',
        kind: 'workspace',
        confidential: { requested: true } as never,
      }),
    (error: unknown) =>
      error instanceof Error && error.message === 'Confidential placement request is invalid',
  )
})

test('direct fork effects reject invalid or changed confidential requests before provider work', async () => {
  const provider = workspaceProvider()
  const execution = executionFor({
    capabilities: branchCapabilities(true, true),
    workspaceBranchingProvider: {
      async forEnvironment(sourceEnvironmentId) {
        return sourceEnvironmentId === 'provider-source-environment' ? provider.branching : null
      },
    },
    confidentialAttestationVerifier: () => true,
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    clock: new FixedClock(AT),
  })
  await prepareSource(app)
  await app.send({ operationId: 'op-source-direct-confidential', text: 'source' }).completion
  const confidential = {
    requested: true as const,
    nonce: 'direct-confidential-nonce',
    policy: 'direct-confidential-policy',
    profileDigest: `sha256:${'e'.repeat(64)}` as `sha256:${string}`,
  }
  const planInput = {
    operationId: 'op-direct-confidential',
    kind: 'workspace' as const,
    confidential,
  }
  const plan = await app.conversations.branches.plan(planInput)
  const host: ConversationHost = {
    state: () => app.state(),
    now: () => AT,
    profile: () => app.state().profile,
    execution,
    commit: async () => undefined,
  }

  await assert.rejects(
    () =>
      executeBranchEffect(
        host,
        { ...planInput, confidential: { requested: true } as never, planDigest: plan.digest },
        plan,
        async () => {
          throw new Error('invalid confidential input must not create a branch')
        },
      ),
    (error: unknown) =>
      error instanceof Error && error.message === 'Confidential placement request is invalid',
  )
  await assert.rejects(
    () =>
      executeBranchEffect(
        host,
        {
          ...planInput,
          confidential: { ...confidential, nonce: 'changed-confidential-nonce' },
          planDigest: plan.digest,
        },
        plan,
        async () => {
          throw new Error('changed confidential input must not create a branch')
        },
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'The confidential placement request no longer matches the accepted plan',
  )
  assert.equal(provider.state.checkpointRequests.length, 0)
  assert.equal(provider.state.forkRequests.length, 0)
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
  const plan = await app.conversations.branches.plan({
    operationId: 'op-cross-runner-no-transfer',
    kind: 'cross-runner',
    runner: 'codex',
  })
  assert.equal(plan.allowed, false)
  assert.match(plan.reason ?? '', /context transfer/iu)
})
