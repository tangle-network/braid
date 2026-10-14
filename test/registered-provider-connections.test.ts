import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defineAgentProfile,
  type AgentExactRunControlRef,
  type ConfidentialAttestation,
  type ConfidentialExecutionEnvironment,
} from '@tangle-network/agent-interface'
import {
  execOnlyEnvironmentCapabilities,
  type AgentEnvironmentProvider,
} from '@tangle-network/agent-interface/environment-provider'
import { createAgentEnvironmentProviderRegistry } from '@tangle-network/agent-runtime/kernel'
import { bindCredentialToOrigin } from '../src/adapters/connections/production-connection-credentials.js'
import { createConnectionProviderResolver } from '../src/adapters/connections/registered-provider.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createBundledConnectionProviderRegistry } from '../src/adapters/connections/bundled-provider-registry.js'
import { capabilitiesForConnection } from '../src/adapters/connections/production-connection-providers.js'
import { ConnectionRoutingExecutionPort } from '../src/adapters/runtime/connection-routing-execution.js'
import { createProductionComposition } from '../src/app/production-composition.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createCredentialRefId } from '../src/domain/ids.js'
import { createAdmissionReceipt } from '../src/domain/receipts.js'
import { credentialRef } from '../src/ports/credentials.js'
import {
  UNKNOWN_RUN_CAPABILITIES,
  type ExecuteTurnInput,
  type ExecutionPort,
} from '../src/ports/execution.js'
import { workspaceSnapshotRef } from './support/workspace-snapshot.js'

const at = '2026-10-11T12:00:00.000Z'
const profile = defineAgentProfile({
  name: 'Portable agent',
  harness: 'pi',
  model: { provider: 'openai', default: 'openai/gpt-5' },
})
function connection(account: string): ConnectionRecord {
  return {
    id: createConnectionId(`connection-provider-${account}`),
    kind: 'agent-provider',
    name: account,
    endpoint: 'https://provider.example.test',
    credentialRef: createCredentialRefId(`credential-${account}`),
    providerOptions: { provider: 'same-provider', transport: 'https', account },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}
function turn(record: ConnectionRecord, runId: string): ExecuteTurnInput {
  return {
    operationId: `operation-${runId}`,
    runId,
    turnId: `turn-${runId}`,
    text: 'Continue here',
    profile,
    connectionId: record.id,
    signal: new AbortController().signal,
  }
}
async function credentialsFor(records: readonly ConnectionRecord[]) {
  const credentials = new MemoryCredentialStore()
  for (const record of records)
    await credentials.store({
      ref: credentialRef(`cred:v1:${record.providerOptions.account}`),
      value: bindCredentialToOrigin(
        new TextEncoder().encode(`private-${record.providerOptions.account}`),
        record.endpoint!,
      ),
    })
  return {
    credentials,
    credentialRefResolver: (ref: string) =>
      credentialRef(`cred:v1:${ref.replace('credential-', '')}`),
  }
}

test('two saved connections with one provider name keep separate credentials and prepared instances', async () => {
  const first = connection('first')
  const second = connection('second')
  const calls: Array<{
    connection: string
    account: string | undefined
    credential: string | undefined
  }> = []
  const options = await credentialsFor([first, second])
  const resolve = createConnectionProviderResolver({
    ...options,
    providerRegistryFactory: ({ record, credential }) => {
      calls.push({ connection: record.id, account: record.providerOptions.account, credential })
      const provider: AgentEnvironmentProvider = {
        name: 'same-provider',
        capabilities: () =>
          execOnlyEnvironmentCapabilities({
            read: false,
            write: false,
            exec: false,
            git: false,
            upload: false,
            download: false,
          }),
        async create() {
          throw new Error('No allocation in preparation')
        },
      }
      return createAgentEnvironmentProviderRegistry([provider])
    },
  })
  const [a, b, replay] = await Promise.all([resolve(first), resolve(second), resolve(first)])
  assert.equal(a, replay)
  assert.notEqual(a, b)
  assert.deepEqual(calls, [
    { connection: first.id, account: 'first', credential: 'private-first' },
    { connection: second.id, account: 'second', credential: 'private-second' },
  ])
  assert.doesNotMatch(JSON.stringify([first, second]), /private-first|private-second/u)
})

test('first dispatch, cancel, replay and restart controls use the admitted connection after selection changes', async () => {
  const first = connection('first')
  const second = connection('second')
  const catalog = new ConnectionRegistry([first, second])
  const observed: string[] = []
  const create = (record: ConnectionRecord): ExecutionPort => ({
    capabilities: () => UNKNOWN_RUN_CAPABILITIES,
    async admit() {
      observed.push(`admit:${record.id}`)
      return { provider: 'same-provider', capabilities: UNKNOWN_RUN_CAPABILITIES }
    },
    async *streamTurn() {
      observed.push(`dispatch:${record.id}`)
      yield* []
    },
    async cancelRun(input) {
      observed.push(`cancel:${record.id}`)
      return { operationId: input.operationId, outcome: 'accepted' }
    },
    async status(input) {
      observed.push(`status:${record.id}`)
      return { runId: input.runId, status: 'running' }
    },
    async *reconnect() {
      observed.push(`replay:${record.id}`)
      yield* []
    },
  })
  const routing = new ConnectionRoutingExecutionPort({
    connections: catalog,
    defaultConnectionId: first.id,
    create,
  })
  const input = turn(second, 'run-second')
  const admission = await routing.admit(input)
  assert.ok(admission.capabilities)
  assert.ok(admission.materializationReceipt)
  catalog.upsert({
    ...second,
    endpoint: 'https://changed.example.test',
    updatedAt: '2026-10-11T12:01:00.000Z',
  })
  for await (const _ of routing.streamTurn(input)) {
    /* drain */
  }
  await routing.cancelRun({ runId: input.runId, operationId: 'operation-cancel' })
  const receipt = createAdmissionReceipt({
    operationId: input.operationId,
    runId: input.runId,
    text: input.text,
    profile: input.profile,
    connectionId: input.connectionId!,
    turnId: input.turnId!,
    conversationId: 'conversation-test',
    branchId: 'branch-test',
    admittedAt: at,
    capabilities: UNKNOWN_RUN_CAPABILITIES,
    materializationReceipt: admission.materializationReceipt,
  })
  const restarted = new ConnectionRoutingExecutionPort({
    connections: new ConnectionRegistry([first, second]),
    defaultConnectionId: first.id,
    create,
  })
  await restarted.status({ runId: input.runId, receipt })
  for await (const _ of restarted.reconnect({
    runId: input.runId,
    receipt,
    signal: input.signal,
  })) {
    /* drain */
  }
  assert.deepEqual(observed, [
    `admit:${second.id}`,
    `dispatch:${second.id}`,
    `cancel:${second.id}`,
    `status:${second.id}`,
    `replay:${second.id}`,
  ])
  const changed = new ConnectionRoutingExecutionPort({
    connections: catalog,
    defaultConnectionId: first.id,
    create,
  })
  await assert.rejects(changed.status({ runId: input.runId, receipt }), /connection changed/u)
  await assert.rejects(routing.admit({ ...input, connectionId: first.id }), /another connection/u)
})

test('exec-only adapters refuse full-profile execution and transfer before provider create', async () => {
  const record = connection('first')
  let creates = 0
  let transfers = 0
  const capabilities = execOnlyEnvironmentCapabilities({
    read: false,
    write: false,
    exec: false,
    git: false,
    upload: false,
    download: false,
  })
  const provider: AgentEnvironmentProvider = {
    name: 'same-provider',
    capabilities: () => capabilities,
    async create() {
      creates += 1
      throw new Error('must not allocate')
    },
    contextTransfer: {
      async lookup() {
        return undefined
      },
      async transfer() {
        transfers += 1
        throw new Error('must not transfer')
      },
    },
  }
  const production = createProductionComposition({
    profile,
    connections: [record],
    connectionId: record.id,
    connectionOptions: {
      ...(await credentialsFor([record])),
      providerRegistryFactory: () => createAgentEnvironmentProviderRegistry([provider]),
    },
  })
  await assert.rejects(
    async () => production.execution.admit?.(turn(record, 'run-unsupported')),
    /agent turn streaming|durable retry identity/u,
  )
  assert.equal(
    await production.execution.context?.supports?.(
      {
        runner: 'pi',
        provider: 'same-provider',
        sessionId: 'session-destination',
        runId: 'run-destination',
        executionId: 'execution-destination',
        profileDigest: `sha256:${'a'.repeat(64)}`,
      },
      { connectionId: record.id },
    ),
    false,
  )
  assert.equal(creates, 0)
  assert.equal(transfers, 0)
})

test('legacy receipts retain their saved connection and unknown recovery fails closed', async () => {
  const first = connection('first')
  const second = connection('second')
  let selected: string | undefined
  const routing = new ConnectionRoutingExecutionPort({
    connections: new ConnectionRegistry([first, second]),
    defaultConnectionId: first.id,
    create: (record) => ({
      async *streamTurn() {},
      async status() {
        selected = record.id
        return null
      },
    }),
  })
  const receipt = createAdmissionReceipt({
    operationId: 'operation-legacy',
    runId: 'run-legacy',
    text: 'Continue',
    profile,
    connectionId: second.id,
    turnId: 'turn-legacy',
    conversationId: 'conversation-test',
    branchId: 'branch-test',
    admittedAt: at,
    capabilities: UNKNOWN_RUN_CAPABILITIES,
  })
  await routing.status({ runId: 'run-legacy', receipt })
  assert.equal(selected, second.id)
  await assert.rejects(routing.status({ runId: 'run-unbound' }), /admitted connection identity/u)
})

test('workspace lookup follows the source run connection and refuses a changed revision after restart', async () => {
  const first = connection('first')
  const second = connection('second')
  const catalog = new ConnectionRegistry([first, second])
  const lookups: string[] = []
  const verificationAccounts: string[] = []
  const create = (record: ConnectionRecord): ExecutionPort => ({
    async *streamTurn() {},
    async admit() {
      return { capabilities: UNKNOWN_RUN_CAPABILITIES }
    },
    workspaceBranchingProvider: {
      async forEnvironment(environmentId, operation) {
        assert.equal(Object.hasOwn(operation ?? {}, 'receipt'), false)
        lookups.push(`${record.id}:${environmentId}`)
        return null
      },
    },
    confidentialAttestationVerifier(attestation) {
      verificationAccounts.push(record.id)
      return attestation.policy === record.id
    },
  })
  const routing = new ConnectionRoutingExecutionPort({
    connections: catalog,
    defaultConnectionId: first.id,
    create,
  })
  const input = turn(second, 'run-workspace-source')
  const admission = await routing.admit(input)
  assert.ok(admission.capabilities)
  assert.ok(admission.materializationReceipt)
  const receipt = createAdmissionReceipt({
    operationId: input.operationId,
    runId: input.runId,
    turnId: input.turnId!,
    text: input.text,
    profile: input.profile,
    connectionId: second.id,
    environmentId: 'environment-source-second',
    conversationId: 'conversation-test',
    branchId: 'branch-test',
    admittedAt: at,
    capabilities: UNKNOWN_RUN_CAPABILITIES,
    materializationReceipt: admission.materializationReceipt,
  })
  const controlRef: AgentExactRunControlRef = {
    provider: 'same-provider',
    environmentId: 'environment-source-second',
    sessionId: 'session-source',
    executionId: 'execution-source',
    runId: 'provider-run-source',
    requestDigest: `sha256:${'a'.repeat(64)}`,
  }
  const expected: ConfidentialExecutionEnvironment = {
    provider: controlRef.provider,
    environmentId: 'environment-destination',
    source: controlRef,
    requestDigest: `sha256:${'b'.repeat(64)}`,
    confidentialRequested: true,
  }
  const attestation: ConfidentialAttestation = {
    ...expected,
    requested: true,
    nonce: 'nonce-source',
    measurement: `sha256:${'c'.repeat(64)}`,
    profileDigest: `sha256:${'d'.repeat(64)}`,
    policy: second.id,
    quote: 'fixture-quote',
    providerKeyId: 'fixture-key',
    providerSignature: 'fixture-signature',
    verifiedAt: at,
  }
  assert.equal(routing.confidentialAttestationVerifier?.(attestation, expected), false)
  await routing.workspaceBranchingProvider!.forEnvironment('environment-source-second', {
    runId: input.runId,
    receipt,
    controlRef,
  })
  assert.equal(routing.confidentialAttestationVerifier?.(attestation, expected), true)
  const restarted = new ConnectionRoutingExecutionPort({
    connections: catalog,
    defaultConnectionId: first.id,
    create,
  })
  await restarted.workspaceBranchingProvider!.forEnvironment('environment-source-second', {
    runId: input.runId,
    receipt: JSON.parse(JSON.stringify(receipt)) as typeof receipt,
    controlRef,
  })
  assert.equal(restarted.confidentialAttestationVerifier?.(attestation, expected), true)
  assert.equal(
    restarted.confidentialAttestationVerifier?.(attestation, {
      ...expected,
      source: { ...controlRef, runId: 'provider-run-unbound' },
    }),
    false,
  )
  assert.deepEqual(verificationAccounts, [second.id, second.id])
  assert.deepEqual(lookups, [
    `${second.id}:environment-source-second`,
    `${second.id}:environment-source-second`,
  ])
  await assert.rejects(
    restarted.workspaceBranchingProvider!.forEnvironment('another-environment', {
      runId: input.runId,
      receipt,
    }),
    /another admitted environment/u,
  )
  await assert.rejects(
    restarted.workspaceBranchingProvider!.forEnvironment('environment-source-second'),
    /source run identity/u,
  )
  catalog.upsert({
    ...second,
    endpoint: 'https://changed.example.test',
    updatedAt: '2026-10-11T12:01:00.000Z',
  })
  const changed = new ConnectionRoutingExecutionPort({
    connections: catalog,
    defaultConnectionId: first.id,
    create,
  })
  await assert.rejects(
    changed.workspaceBranchingProvider!.forEnvironment('environment-source-second', {
      runId: input.runId,
      receipt,
    }),
    /connection changed/u,
  )
  assert.equal(lookups.length, 2)
})

test('registered workspace capabilities refuse unsupported requests before create', async () => {
  const record = connection('first')
  const base = execOnlyEnvironmentCapabilities({
    read: false,
    write: false,
    exec: false,
    git: false,
    upload: false,
    download: false,
  })
  const capabilities = {
    ...base,
    streaming: { ...base.streaming, live: true },
    create: { durableIdempotency: true },
  }
  let creates = 0
  const provider: AgentEnvironmentProvider = {
    name: 'same-provider',
    capabilities: () => capabilities,
    async create() {
      creates += 1
      throw new Error('must not allocate')
    },
  }
  const production = createProductionComposition({
    profile,
    connections: [record],
    connectionId: record.id,
    connectionOptions: {
      ...(await credentialsFor([record])),
      providerRegistryFactory: () => createAgentEnvironmentProviderRegistry([provider]),
    },
  })
  for (const [index, workspaceRequest] of [
    { repoUrl: 'https://github.com/acme/repository' },
    { cwd: { base: 'repository' as const, path: 'src' } },
    { snapshot: workspaceSnapshotRef() },
  ].entries()) {
    await assert.rejects(
      async () =>
        production.execution.admit?.({
          ...turn(record, `run-unsupported-workspace-${index}`),
          workspaceRequest,
        }),
      /cannot restore|cannot honor/u,
    )
  }
  assert.equal(creates, 0)
})

test('registered retained capability reports preserve only qualified lifecycle controls', async () => {
  const ordinary = connection('first')
  const retained = {
    ...ordinary,
    providerOptions: {
      ...ordinary.providerOptions,
      lifecycle: 'retained' as const,
      idleTtlSeconds: 1800,
    },
  }
  const base = execOnlyEnvironmentCapabilities({
    read: false,
    write: false,
    exec: false,
    git: false,
    upload: false,
    download: false,
  })
  const provider: AgentEnvironmentProvider = {
    name: 'same-provider',
    capabilities: () => ({
      ...base,
      create: { durableIdempotency: true },
      streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
      retainedControl: {
        exactRunIdentity: true,
        resultIdentity: true,
        eventIdentity: true,
        cancellationIdempotency: true,
      },
    }),
    async create() {
      throw new Error('must not allocate')
    },
    async get() {
      return null
    },
  }
  const options = {
    ...(await credentialsFor([ordinary])),
    providerRegistryFactory: () => createAgentEnvironmentProviderRegistry([provider]),
  }
  const ephemeral = await capabilitiesForConnection(ordinary, options)
  const durable = await capabilitiesForConnection(retained, options)
  assert.equal(ephemeral.actions.replay, false)
  assert.equal(ephemeral.actions.detach, false)
  assert.equal(durable.actions.replay, true)
  assert.equal(durable.actions.detach, true)
})

test('bundled providers never resolve ambient endpoint, region or credential settings', async () => {
  const record = connection('first')
  await assert.rejects(
    async () =>
      createBundledConnectionProviderRegistry({
        record: { ...record, providerOptions: { ...record.providerOptions, provider: 'e2b' } },
        endpoint: record.endpoint!,
        credential: 'fixture-credential',
      }),
    /explicit connection endpoint/u,
  )
  await assert.rejects(
    async () =>
      createBundledConnectionProviderRegistry({
        record: { ...record, providerOptions: { ...record.providerOptions, provider: 'daytona' } },
        endpoint: record.endpoint!,
        credential: undefined,
      }),
    /selected connection credential/u,
  )
  await assert.rejects(
    async () =>
      createBundledConnectionProviderRegistry({
        record: { ...record, providerOptions: { ...record.providerOptions, provider: 'daytona' } },
        endpoint: record.endpoint!,
        credential: 'fixture-credential',
      }),
    /explicit target region/u,
  )
  const registry = await createBundledConnectionProviderRegistry({
    record: {
      ...record,
      providerOptions: { ...record.providerOptions, provider: 'daytona', region: 'us' },
    },
    endpoint: record.endpoint!,
    credential: 'fixture-credential',
  })
  const provider = registry.require('daytona')
  assert.equal((await provider.capabilities()).streaming.live, false)
  assert.equal(provider.contextTransfer, undefined)
})
