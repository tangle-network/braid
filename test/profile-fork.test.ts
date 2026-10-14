import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import type {
  AgentExactRunControlRef,
  AgentProfile,
  ContextTransferRequest,
  ContextTransferResult,
} from '@tangle-network/agent-interface'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { canonicalAgentProfileDigestHex } from '../src/adapters/agent-interface/profile-runtime.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import {
  type ConversationDispatchContext,
  dispatchConversationHeadlessCommand,
  dispatchConversationRunCommand,
} from '../src/adapters/tui/ui-conversation-dispatch.js'
import type { BraidApplication } from '../src/app/application.js'
import { createBraidApplication } from '../src/app/composition.js'
import { executeBranchEffect } from '../src/app/conversation-branch-effects.js'
import type { ConversationHost, ForkDestinationProfile } from '../src/app/conversation-types.js'
import { MemoryJournal } from '../src/app/journal.js'
import { ProfileActionService } from '../src/app/profile-actions.js'
import { createProfileRecord, type ProfileDiscoveryInput } from '../src/app/profiles.js'
import { StorageJournal } from '../src/app/storage-journal.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createOperationId } from '../src/domain/ids.js'
import { replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import { credentialRef } from '../src/ports/credentials.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecuteTurnInput,
  type ExecutionPort,
  type RunCapabilities,
} from '../src/ports/execution.js'
import { RandomIds } from '../src/ports/ids.js'
import { parseRequest } from '../src/views/headless/rpc-parser.js'
import type { BraidViewModel } from '../src/views/shared/models.js'
import { ConversationOverlayActions } from '../src/views/tui/conversation-overlay-actions.js'
import { ForkPreviewPanel } from '../src/views/tui/fork-preview.js'
import { ModalCoordinator } from '../src/views/tui/modal-coordinator.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const AT = '2026-10-14T00:00:00.000Z'
const SOURCE_PROVIDER = 'source-provider'
const SOURCE_SESSION = 'provider-session-source'
const theme = createBraidTheme(false)

const SOURCE_PROFILE = defineAgentProfile({
  name: 'Source operator',
  harness: 'pi',
  model: { default: 'source-model' },
  prompt: { instructions: ['Work in the source role.'] },
})

const DESTINATION_PROFILE = defineAgentProfile({
  name: 'Discovery operator',
  description: 'Reviews findings and cites evidence',
  harness: 'pi',
  model: { default: 'destination-model' },
  prompt: { instructions: ['DESTINATION_ROLE_INSTRUCTION'] },
})

interface Harness {
  readonly execution: ExecutionPort
  readonly transfers: ContextTransferRequest[]
  readonly admitted: ExecuteTurnInput[]
}

function capabilities(): RunCapabilities {
  return {
    ...DEFAULT_RUN_CAPABILITIES,
    streaming: { ...DEFAULT_RUN_CAPABILITIES.streaming, replay: true },
    sessions: { continue: true, messages: true },
    events: { stableIdentity: true, sequence: true, cursor: true },
  } as unknown as RunCapabilities
}

function control(runId: string): AgentExactRunControlRef {
  return {
    runId,
    provider: SOURCE_PROVIDER,
    environmentId: 'provider-source-environment',
    sessionId: SOURCE_SESSION,
    executionId: 'provider-source-execution',
    requestDigest: `sha256:${'1'.repeat(64)}`,
  }
}

function receipt(request: ContextTransferRequest): ContextTransferResult {
  const plan = request.plan
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
    transferredMessageIds: plan.messages
      .filter((message) => message.action === 'include')
      .map((message) => message.messageId),
    omittedMessageIds: plan.messages
      .filter((message) => message.action === 'omit')
      .map((message) => message.messageId),
    admittedAt: AT,
  }
}

/** A provider double with exact transfer lookup; it records the profile of every admitted turn. */
function harness(): Harness {
  const transfers: ContextTransferRequest[] = []
  const admitted: ExecuteTurnInput[] = []
  const accepted = new Map<string, ContextTransferResult>()
  const execution: ExecutionPort = {
    admissionMode: 'sync',
    capabilities: () => capabilities(),
    admit(input) {
      admitted.push(input)
      const destination = input.contextTransfer !== undefined
      const provider = destination
        ? (input.contextTransferReceipt?.provider ??
          input.contextTransfer?.plan.destination.provider ??
          'destination-provider')
        : SOURCE_PROVIDER
      return {
        capabilities: capabilities(),
        provider,
        environmentId: destination
          ? (input.contextTransferReceipt?.environmentId ?? 'provider-context-destination')
          : 'provider-source-environment',
        providerSessionId: destination
          ? input.contextTransfer?.plan.destination.sessionId
          : SOURCE_SESSION,
        materializationReceipt: { provider },
      }
    },
    async *streamTurn(input) {
      if (input.contextTransfer === undefined) {
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
          controlRef: control(input.runId),
          timestamp: AT,
        }
      }
      yield {
        type: 'final',
        status: 'completed',
        reason: 'completed',
        text: `${input.profile.name ?? 'unnamed'} answered ${input.text}`,
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: `task-${input.runId}`, intent: input.text },
        timestamp: AT,
      }
    },
    context: {
      async supports() {
        return true
      },
      async lookup(request: ContextTransferRequest) {
        return accepted.get(request.operationId)
      },
      async transfer(request: ContextTransferRequest) {
        transfers.push(request)
        const result = receipt(request)
        accepted.set(request.operationId, result)
        return result
      },
    },
  }
  return { execution, transfers, admitted }
}

function sourceConnection(): ConnectionRecord {
  return {
    id: createConnectionId('connection-profile-fork-source'),
    kind: 'tangle-sandbox',
    name: 'profile fork source',
    providerOptions: { transport: 'local' },
    createdAt: AT,
    updatedAt: AT,
    lastHealth: { status: 'unknown' },
  }
}

async function prepareSource(app: BraidApplication): Promise<void> {
  app.initialize('/workspace')
  const connection = sourceConnection()
  await app.configuration.selectConnection({
    connection,
    operation: {
      id: createOperationId('operation-select-profile-fork-source'),
      kind: 'connection-change',
      requestDigest: canonicalDigest({ command: 'select_connection', connectionId: connection.id }),
      status: 'acknowledged',
      target: { kind: 'connection', id: connection.id },
      result: { connectionId: connection.id },
      createdAt: AT,
      updatedAt: AT,
      acknowledgedAt: AT,
    },
  })
}

function openApp(
  execution: ExecutionPort,
  journal: MemoryJournal | StorageJournal,
  profile: Readonly<AgentProfile> = SOURCE_PROFILE,
): BraidApplication {
  return createBraidApplication({
    fixture: 'deterministic',
    profile,
    ids: new RandomIds(),
    execution,
    clock: new FixedClock(AT),
    journal,
    effectStorage: journal,
  })
}

function catalogRecord(profile: Readonly<AgentProfile> = DESTINATION_PROFILE) {
  return createProfileRecord(
    {
      kind: 'inline',
      reference: 'braid:test-discovery-operator',
      label: profile.name ?? 'Discovery operator',
      writable: false,
      trusted: true,
    },
    profile,
  )
}

function profileService(
  app: BraidApplication,
  options: {
    readonly profiles?: ReturnType<typeof catalogRecord>[]
    readonly discovery?: ProfileDiscoveryInput
  } = { profiles: [catalogRecord()] },
): ProfileActionService {
  return new ProfileActionService({
    host: {
      state: () => app.state(),
      configuration: app.configuration,
      runtime: app.runtimeSelection,
    },
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
    ...(options.discovery === undefined ? {} : { discovery: options.discovery }),
  })
}

function dispatchContext(
  app: BraidApplication,
  profiles: ProfileActionService | undefined,
): ConversationDispatchContext & { preview(): BraidViewModel['forkPreview'] } {
  let preview: BraidViewModel['forkPreview']
  return {
    app,
    view: () => ({}) as never,
    ...(profiles === undefined ? {} : { profileConnections: { profiles } }),
    setNotice: () => undefined,
    setForkPreview: (value) => {
      preview = value
    },
    preview: () => preview,
  }
}

function effectiveDigest(profile: Readonly<AgentProfile>): string {
  return `sha256:${canonicalAgentProfileDigestHex(profile)}`
}

function lastAdmitted(admitted: readonly ExecuteTurnInput[]): ExecuteTurnInput {
  const input = admitted.at(-1)
  assert(input)
  return input
}

test('a profile-changing fork binds the destination profile through handoff, later turns, and restart', async () => {
  const provider = harness()
  const journal = new MemoryJournal(new FixedClock(AT))
  const app = openApp(provider.execution, journal)
  await prepareSource(app)
  await app.send({ operationId: 'op-profile-source', text: 'source history' }).completion
  const sourceBranchId = app.state().branchId
  const destination = await profileService(app).resolveForFork('Discovery operator')
  const input = {
    operationId: 'op-profile-fork',
    destinationProfile: destination,
    text: 'Continue as the operator',
  }

  const plan = await app.conversations.branches.plan(input)
  assert.equal(plan.kind, 'cross-runner')
  assert.equal(plan.allowed, true)
  assert.equal(plan.providerSession, 'new')
  assert.equal(plan.profileSelection?.name, 'Discovery operator')
  assert.equal(plan.profileSelection?.sourceName, 'Source operator')
  assert.equal(plan.profileSelection?.digest, canonicalAgentProfileDigestHex(DESTINATION_PROFILE))
  assert.equal(plan.destinationProfile?.name, 'Discovery operator')
  assert.equal(
    plan.portableContextPlan?.destination.profileDigest,
    effectiveDigest(plan.destinationProfile ?? SOURCE_PROFILE),
  )

  const branch = await app.conversations.branches.execute({
    ...input,
    planDigest: plan.digest,
    ...(plan.portableContextPlan?.requiresAcceptance === true
      ? { acceptedDigest: plan.portableContextPlan.digest }
      : {}),
  })
  assert.equal(branch.id, plan.destinationBranchId)
  assert.equal(provider.transfers.length, 1)
  assert.equal(provider.transfers[0]?.profile?.name, 'Discovery operator')
  const snapshot = app.state().profileSnapshots.find((item) => item.id === branch.profileSnapshotId)
  assert(snapshot)
  assert.equal(snapshot.digest, canonicalAgentProfileDigestHex(DESTINATION_PROFILE))
  assert.equal(branch.profileId, destination.profileId)
  const handoff = app.state().operations.find((operation) => operation.id === input.operationId)
  assert.equal(handoff?.status, 'acknowledged')
  assert.equal(handoff?.result?.profileSnapshotId, snapshot.id)
  await app.waitForIdle()
  const first = lastAdmitted(provider.admitted)
  assert.equal(app.state().runs.find((run) => run.id === first.runId)?.branchId, branch.id)
  assert.equal(first.profile.name, 'Discovery operator')
  assert.equal(effectiveDigest(first.profile), plan.portableContextPlan?.destination.profileDigest)
  assert.deepEqual(first.contextTransfer, provider.transfers[0])

  await app.send({ operationId: 'op-profile-second', branchId: branch.id, text: 'second' })
    .completion
  assert.equal(lastAdmitted(provider.admitted).profile.name, 'Discovery operator')
  await app.send({ operationId: 'op-source-second', branchId: sourceBranchId, text: 'source' })
    .completion
  assert.equal(lastAdmitted(provider.admitted).profile.name, 'Source operator')

  // Idempotent: the same operation returns the same branch without new effects.
  const repeated = await app.conversations.branches.execute({ ...input, planDigest: plan.digest })
  assert.equal(repeated.id, branch.id)
  assert.equal(provider.transfers.length, 1)
  assert.equal(app.state().profileSnapshots.length, 1)

  const restarted = openApp(provider.execution, journal)
  const replayed = await restarted.conversations.branches.execute({
    ...input,
    planDigest: plan.digest,
  })
  assert.equal(replayed.id, branch.id)
  assert.equal(provider.transfers.length, 1)
  assert.deepEqual(restarted.state().profileSnapshots, app.state().profileSnapshots)
  await restarted.send({ operationId: 'op-profile-restart', branchId: branch.id, text: 'after' })
    .completion
  assert.equal(lastAdmitted(provider.admitted).profile.name, 'Discovery operator')
  await restarted.send({ operationId: 'op-source-restart', branchId: sourceBranchId, text: 'src' })
    .completion
  assert.equal(lastAdmitted(provider.admitted).profile.name, 'Source operator')

  const fullReplay = replayEvents(initialState(SOURCE_PROFILE), restarted.events())
  assert.deepEqual(fullReplay.profileSnapshots, restarted.state().profileSnapshots)
  assert.deepEqual(
    fullReplay.branches.find((candidate) => candidate.id === branch.id),
    restarted.state().branches.find((candidate) => candidate.id === branch.id),
  )
})

test('a branch made from a profile-bound branch keeps the bound profile', async () => {
  const provider = harness()
  const app = openApp(provider.execution, new MemoryJournal(new FixedClock(AT)))
  await prepareSource(app)
  await app.send({ operationId: 'op-child-source', text: 'source history' }).completion
  const destination = await profileService(app).resolveForFork('Discovery operator')
  const input = { operationId: 'op-child-fork', destinationProfile: destination }
  const plan = await app.conversations.branches.plan(input)
  const bound = await app.conversations.branches.execute({ ...input, planDigest: plan.digest })
  const child = await app.conversations.branches.create({
    operationId: 'op-child-branch',
    branchId: bound.id,
  })
  assert.equal(child.profileSnapshotId, bound.profileSnapshotId)
  const runnerFork = await app.conversations.branches.plan({
    operationId: 'op-child-runner-fork',
    branchId: bound.id,
    runner: 'codex',
  })
  assert.equal(runnerFork.profileSelection, undefined)
  assert.equal(runnerFork.destinationProfile?.name, 'Discovery operator')
})

test('a changed profile after acceptance refuses before any provider transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-profile-fork-change-'))
  try {
    const path = join(root, 'discovery-operator.json')
    await writeFile(path, JSON.stringify(DESTINATION_PROFILE))
    const provider = harness()
    const app = openApp(provider.execution, new MemoryJournal(new FixedClock(AT)))
    await prepareSource(app)
    await app.send({ operationId: 'op-change-source', text: 'source history' }).completion
    const profiles = profileService(app, {
      discovery: {
        explicit: [{ kind: 'file', path, reference: path, writable: false, trusted: true }],
      },
    })
    const context = dispatchContext(app, profiles)
    const planned = await dispatchConversationRunCommand(
      {
        type: 'run-command',
        command: 'fork',
        operationId: 'op-change-fork',
        args: ['--profile', path],
      },
      context,
    )
    assert.equal(planned?.kind, 'accepted')
    const preview = context.preview()
    assert(preview?.plan && preview.execution?.params)
    assert.equal(preview.execution.params.profileRef, path)
    assert.equal(Object.hasOwn(preview.execution.params, 'destinationProfile'), false)

    await writeFile(
      path,
      JSON.stringify({ ...DESTINATION_PROFILE, prompt: { instructions: ['changed role'] } }),
    )
    const revision = app.state().revision
    const reviewed = preview.execution
    const reviewedPlan = preview.plan
    await assert.rejects(
      () =>
        dispatchConversationHeadlessCommand(
          {
            type: 'headless-command',
            command: 'execute_fork',
            operationId: reviewed.operationId,
            params: { ...reviewed.params, planDigest: reviewedPlan.digest },
          },
          context,
        ),
      /accepted fork plan no longer matches/u,
    )
    assert.equal(provider.transfers.length, 0)
    assert.equal(app.state().revision, revision)
    assert.equal(app.state().profileSnapshots.length, 0)

    // The provider effect refuses a mismatched profile before reserving work.
    const plan = preview.plan
    const original = await profiles.resolveForFork(path)
    const host: ConversationHost = {
      state: () => app.state(),
      now: () => AT,
      commit: async () => {
        throw new Error('a refused profile must not reach the journal')
      },
      execution: provider.execution,
    }
    const changed: ForkDestinationProfile = {
      ...original,
      profile: { ...original.profile, name: 'Swapped profile' },
    }
    await assert.rejects(
      () =>
        executeBranchEffect(
          host,
          {
            operationId: plan.operationId,
            destinationProfile: changed,
            planDigest: plan.digest,
            ...(plan.portableContextPlan === undefined
              ? {}
              : { acceptedDigest: plan.portableContextPlan.digest }),
          },
          plan,
          async () => {
            throw new Error('branch creation must not run')
          },
        ),
      /destination profile changed after the accepted plan/u,
    )
    assert.equal(provider.transfers.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('untrusted, unknown, and unavailable profile references refuse before planning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-profile-fork-trust-'))
  try {
    const path = join(root, 'workspace-profile.json')
    await writeFile(path, JSON.stringify(DESTINATION_PROFILE))
    const provider = harness()
    const app = openApp(provider.execution, new MemoryJournal(new FixedClock(AT)))
    await prepareSource(app)
    await app.send({ operationId: 'op-trust-source', text: 'source history' }).completion
    const revision = app.state().revision

    const untrusted = profileService(app, {
      discovery: {
        workspace: [{ kind: 'file', path, reference: path, trusted: false }],
        workspaceTrusted: false,
      },
    })
    await assert.rejects(
      () => untrusted.resolveForFork(path),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROFILE_NOT_FOUND' &&
        /not a listed or trusted profile/u.test(error.message),
    )
    await assert.rejects(
      () =>
        dispatchConversationRunCommand(
          {
            type: 'run-command',
            command: 'fork',
            operationId: 'op-unknown-profile',
            args: ['--profile', 'Missing operator'],
          },
          dispatchContext(app, profileService(app)),
        ),
      /Missing operator is not a listed or trusted profile/u,
    )
    await assert.rejects(
      () =>
        dispatchConversationHeadlessCommand(
          {
            type: 'headless-command',
            command: 'plan_fork',
            operationId: 'op-no-catalog',
            params: { profileRef: 'Discovery operator' },
          },
          dispatchContext(app, undefined),
        ),
      /no profile catalog/u,
    )
    await assert.rejects(
      () =>
        dispatchConversationRunCommand(
          {
            type: 'run-command',
            command: 'fork',
            operationId: 'op-empty-profile',
            args: ['--profile'],
          },
          dispatchContext(app, profileService(app)),
        ),
      /requires a profile reference/u,
    )
    assert.equal(app.state().revision, revision)
    assert.equal(provider.transfers.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('profile forks require a context handoff and fail closed when the profile cannot be retained', async () => {
  const provider = harness()
  const app = openApp(provider.execution, new MemoryJournal(new FixedClock(AT)))
  await prepareSource(app)
  await app.send({ operationId: 'op-kind-source', text: 'source history' }).completion
  const destination = await profileService(app).resolveForFork('Discovery operator')
  for (const kind of ['workspace', 'conversation'] as const)
    await assert.rejects(
      () =>
        app.conversations.branches.plan({
          operationId: `op-profile-${kind}`,
          kind,
          destinationProfile: destination,
        }),
      /workspace and conversation-only forks keep the source profile/u,
    )

  const deep = defineAgentProfile({
    ...DESTINATION_PROFILE,
    metadata: { a: { b: { c: { d: { e: { f: { g: { value: 'nested' } } } } } } } },
  })
  const unretained = await app.conversations.branches.plan({
    operationId: 'op-profile-deep',
    destinationProfile: { ...destination, profile: deep },
  })
  assert.equal(unretained.allowed, false)
  assert.equal(unretained.environment, 'unavailable')
  assert.match(unretained.reason ?? '', /cannot keep for a branch without redaction/u)
  await assert.rejects(
    () =>
      app.conversations.branches.execute({
        operationId: 'op-profile-deep',
        destinationProfile: { ...destination, profile: deep },
        planDigest: unretained.digest,
      }),
    /cannot keep for a branch without redaction/u,
  )
  assert.equal(provider.transfers.length, 0)
})

test('legacy handoffs without a destination profile replay and keep the selected profile', async () => {
  const provider = harness()
  const journal = new MemoryJournal(new FixedClock(AT))
  const app = openApp(provider.execution, journal)
  await prepareSource(app)
  await app.send({ operationId: 'op-legacy-source', text: 'source history' }).completion
  const input = { operationId: 'op-legacy-handoff', runner: 'codex' }
  const plan = await app.conversations.branches.plan(input)
  assert.equal(plan.profileSelection, undefined)
  assert.equal(Object.hasOwn(plan, 'profileSelection'), false)
  const branch = await app.conversations.branches.execute({ ...input, planDigest: plan.digest })
  assert.equal(branch.profileSnapshotId, undefined)
  const result = app.state().operations.find((operation) => operation.id === input.operationId)
  assert.equal(Object.hasOwn(result?.result ?? {}, 'profileSnapshotId'), false)

  const restarted = openApp(provider.execution, journal)
  const replay = replayEvents(initialState(SOURCE_PROFILE), restarted.events())
  assert.deepEqual(replay.profileSnapshots, [])
  assert.equal(
    replay.branches.find((candidate) => candidate.id === branch.id)?.profileSnapshotId,
    undefined,
  )
  assert.equal(
    (await restarted.conversations.branches.execute({ ...input, planDigest: plan.digest })).id,
    branch.id,
  )
  await restarted.send({ operationId: 'op-legacy-turn', branchId: branch.id, text: 'next' })
    .completion
  const turn = lastAdmitted(provider.admitted)
  assert.equal(turn.profile.name, 'Source operator')
  assert.equal(turn.profile.harness, 'codex')
  assert.equal(provider.transfers.length, 1)
})

test('a profile fork without text survives encrypted SQLite close and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-profile-fork-sqlite-'))
  const options = {
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    databaseKeyRef: credentialRef('cred:v1:profile-fork-database'),
  }
  const provider = harness()
  let app = openApp(
    provider.execution,
    await StorageJournal.fromStorage(await openSqliteStorage(options), new FixedClock(AT)),
  )
  try {
    app.initialize('/workspace')
    await app.whenDurable()
    await prepareSource(app)
    await app.send({ operationId: 'op-sqlite-profile-source', text: 'retained source' }).completion
    const destination = await profileService(app).resolveForFork('Discovery operator')
    const input = { operationId: 'op-sqlite-profile-fork', destinationProfile: destination }
    const plan = await app.conversations.branches.plan(input)
    const branch = await app.conversations.branches.execute({ ...input, planDigest: plan.digest })
    await app.whenDurable()
    const snapshots = app.state().profileSnapshots
    assert.equal(snapshots.length, 1)
    await app.close()

    app = openApp(
      provider.execution,
      await StorageJournal.fromStorage(await openSqliteStorage(options), new FixedClock(AT)),
    )
    assert.deepEqual(app.state().profileSnapshots, snapshots)
    assert.equal(
      app.state().branches.find((candidate) => candidate.id === branch.id)?.profileSnapshotId,
      snapshots[0]?.id,
    )
    await app.send({ operationId: 'op-sqlite-profile-turn', branchId: branch.id, text: 'go' })
      .completion
    const first = lastAdmitted(provider.admitted)
    assert.equal(first.profile.name, 'Discovery operator')
    assert.deepEqual(first.contextTransfer, provider.transfers[0])
    assert.equal(provider.transfers.length, 1)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('headless plan_fork and execute_fork accept profileRef and never echo the profile', async () => {
  const parsed = parseRequest(
    JSON.stringify({
      version: 1,
      requestId: 'rpc-profile-fork',
      operationId: 'op-rpc-profile-fork',
      command: 'plan_fork',
      params: { profileRef: 'Discovery operator' },
    }),
  )
  assert.equal(
    (parsed.params as Readonly<Record<string, unknown>> | undefined)?.profileRef,
    'Discovery operator',
  )
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({
          version: 1,
          requestId: 'rpc-profile-fork-invalid',
          operationId: 'op-rpc-profile-fork-invalid',
          command: 'execute_fork',
          params: { planDigest: 'digest', profileRef: 7 },
        }),
      ),
    /profileRef/u,
  )

  const provider = harness()
  const app = openApp(provider.execution, new MemoryJournal(new FixedClock(AT)))
  await prepareSource(app)
  await app.send({ operationId: 'op-rpc-source', text: 'source history' }).completion
  const context = dispatchContext(app, profileService(app))
  const planned = await dispatchConversationHeadlessCommand(
    {
      type: 'headless-command',
      command: 'plan_fork',
      operationId: 'op-rpc-profile-fork',
      params: { profileRef: 'Discovery operator' },
    },
    context,
  )
  assert(planned?.kind === 'accepted')
  const preview = context.preview()
  assert.equal(preview?.execution?.params?.profileRef, 'Discovery operator')
  assert.doesNotMatch(JSON.stringify(preview?.execution?.params), /DESTINATION_ROLE_INSTRUCTION/u)
  assert.deepEqual(
    preview?.fields.find((field) => field.label === 'profile'),
    { label: 'profile', source: 'Source operator', destination: 'Discovery operator' },
  )
  assert.match(
    preview?.fields.find((field) => field.label === 'copied context')?.destination ?? '',
    /^\d+ messages?/u,
  )
  const plan = planned.data as { readonly digest: string }
  const executed = await dispatchConversationHeadlessCommand(
    {
      type: 'headless-command',
      command: 'execute_fork',
      operationId: 'op-rpc-profile-fork',
      params: { planDigest: plan.digest, profileRef: 'Discovery operator' },
    },
    context,
  )
  assert(executed?.kind === 'accepted')
  const branch = executed.data as { readonly profileSnapshotId?: string }
  assert.equal(typeof branch.profileSnapshotId, 'string')
})

function assertFits(lines: readonly string[], width: number): void {
  for (const line of lines)
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
}

test('keyboard review accepts, declines, cancels, and the bound branch survives restart', async () => {
  const provider = harness()
  const journal = new MemoryJournal(new FixedClock(AT))
  const app = openApp(provider.execution, journal)
  await prepareSource(app)
  await app.send({ operationId: 'op-keyboard-source', text: 'source history' }).completion
  const profileOptions = { profiles: [catalogRecord()] }
  const controller = createApplicationUiController(app, {}, undefined, profileOptions)
  const planned = await controller.dispatch({
    type: 'run-command',
    command: 'fork',
    operationId: 'op-keyboard-profile-fork',
    args: ['--profile', 'Discovery operator'],
  })
  assert.equal(planned.kind, 'accepted')
  const view = controller.view()
  assert(view.forkPreview?.allowed)

  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const) {
    const panel = new ForkPreviewPanel(theme, { rows: () => rows })
    panel.setView(view)
    const lines = panel.render(columns)
    assertFits(lines, columns)
    assert.ok(lines.length <= rows)
    if (columns >= 80) {
      const screen = lines.join('\n')
      assert.match(screen, /profile: new session with copied context/u)
      assert.match(screen, /profile: Source operator → Discovery operator/u)
      assert.match(screen, /copied context: selected history → \d+ messages?/u)
      assert.match(screen, /enter\/y create fork/u)
    }
  }

  const tui = new TuiMainScreen(new VirtualTerminal(80, 24))
  const modals = new ModalCoordinator(tui)
  const actions = new ConversationOverlayActions({
    theme,
    controller,
    modals,
    nextOperationId: () => 'operation-unused',
    rows: () => 24,
  })
  try {
    const revision = app.state().revision
    for (const key of ['\u001b', '\u001b[D', '\u0003']) {
      actions.openForkPreview(view)
      assert.equal(modals.hasOpen(), true)
      modals.handleInput(key)
      assert.equal(modals.hasOpen(), false, `key ${JSON.stringify(key)} closes the preview`)
    }
    assert.equal(app.state().revision, revision)
    assert.equal(provider.transfers.length, 0)

    actions.openForkPreview(view)
    modals.handleInput('\r')
    await controller.waitForIdle()
    for (let attempt = 0; attempt < 50 && modals.hasOpen(); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(modals.hasOpen(), false)
  } finally {
    modals.closeAll()
    tui.stop()
  }
  assert.equal(provider.transfers.length, 1)
  const branch = app.state().branches.find((candidate) => candidate.profileSnapshotId !== undefined)
  assert(branch)
  assert.equal(app.state().branchId, branch.id)
  assert.equal(controller.view().profileName, 'Discovery operator')

  const restarted = openApp(provider.execution, journal)
  const restartedController = createApplicationUiController(
    restarted,
    {},
    undefined,
    profileOptions,
  )
  assert.equal(restarted.state().branchId, branch.id)
  assert.equal(restartedController.view().profileName, 'Discovery operator')
  await restarted.send({ operationId: 'op-keyboard-after-restart', text: 'continue' }).completion
  assert.equal(lastAdmitted(provider.admitted).profile.name, 'Discovery operator')
})
