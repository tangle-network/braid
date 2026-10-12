import assert from 'node:assert/strict'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { execOnlyEnvironmentCapabilities, type AgentEnvironmentProvider } from '@tangle-network/agent-interface/environment-provider'
import { createAgentEnvironmentProviderRegistry } from '@tangle-network/agent-runtime/kernel'
import { bindCredentialToOrigin } from '../src/adapters/connections/production-connection-credentials.js'
import { createConnectionProviderResolver } from '../src/adapters/connections/registered-provider.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { ConnectionRoutingExecutionPort } from '../src/adapters/runtime/connection-routing-execution.js'
import { createProductionComposition } from '../src/app/production-composition.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createCredentialRefId } from '../src/domain/ids.js'
import { createAdmissionReceipt } from '../src/domain/receipts.js'
import { credentialRef } from '../src/ports/credentials.js'
import { UNKNOWN_RUN_CAPABILITIES, type ExecuteTurnInput, type ExecutionPort } from '../src/ports/execution.js'

const at = '2026-10-11T12:00:00.000Z'
const profile = defineAgentProfile({ name: 'Portable agent', harness: 'pi', model: { provider: 'openai', default: 'openai/gpt-5' } })
function connection(account: string): ConnectionRecord {
  return { id: createConnectionId(`connection-provider-${account}`), kind: 'agent-provider', name: account, endpoint: 'https://provider.example.test', credentialRef: createCredentialRefId(`credential-${account}`), providerOptions: { provider: 'same-provider', transport: 'https', account }, createdAt: at, updatedAt: at, lastHealth: { status: 'unknown' } }
}
function turn(record: ConnectionRecord, runId: string): ExecuteTurnInput {
  return { operationId: `operation-${runId}`, runId, turnId: `turn-${runId}`, text: 'Continue here', profile, connectionId: record.id, signal: new AbortController().signal }
}
async function credentialsFor(records: readonly ConnectionRecord[]) {
  const credentials = new MemoryCredentialStore()
  for (const record of records) await credentials.store({ ref: credentialRef(`cred:v1:${record.providerOptions.account}`), value: bindCredentialToOrigin(new TextEncoder().encode(`private-${record.providerOptions.account}`), record.endpoint!) })
  return { credentials, credentialRefResolver: (ref: string) => credentialRef(`cred:v1:${ref.replace('credential-', '')}`) }
}

test('two saved connections with one provider name keep separate credentials and prepared instances', async () => {
  const first = connection('first')
  const second = connection('second')
  const calls: Array<{ connection: string; account: string | undefined; credential: string | undefined }> = []
  const options = await credentialsFor([first, second])
  const resolve = createConnectionProviderResolver({ ...options, providerRegistryFactory: ({ record, credential }) => {
    calls.push({ connection: record.id, account: record.providerOptions.account, credential })
    const provider: AgentEnvironmentProvider = { name: 'same-provider', capabilities: () => execOnlyEnvironmentCapabilities({ read: false, write: false, exec: false, git: false, upload: false, download: false }), async create() { throw new Error('No allocation in preparation') } }
    return createAgentEnvironmentProviderRegistry([provider])
  } })
  const [a, b, replay] = await Promise.all([resolve(first), resolve(second), resolve(first)])
  assert.equal(a, replay)
  assert.notEqual(a, b)
  assert.deepEqual(calls, [{ connection: first.id, account: 'first', credential: 'private-first' }, { connection: second.id, account: 'second', credential: 'private-second' }])
  assert.doesNotMatch(JSON.stringify([first, second]), /private-first|private-second/u)
})

test('first dispatch, cancel, replay and restart controls use the admitted connection after selection changes', async () => {
  const first = connection('first')
  const second = connection('second')
  const catalog = new ConnectionRegistry([first, second])
  const observed: string[] = []
  const create = (record: ConnectionRecord): ExecutionPort => ({
    capabilities: () => UNKNOWN_RUN_CAPABILITIES,
    async admit() { observed.push(`admit:${record.id}`); return { provider: 'same-provider', capabilities: UNKNOWN_RUN_CAPABILITIES } },
    async *streamTurn() { observed.push(`dispatch:${record.id}`) },
    async cancelRun(input) { observed.push(`cancel:${record.id}`); return { operationId: input.operationId, outcome: 'accepted' } },
    async status(input) { observed.push(`status:${record.id}`); return { runId: input.runId, status: 'running' } },
    async *reconnect() { observed.push(`replay:${record.id}`) },
  })
  const routing = new ConnectionRoutingExecutionPort({ connections: catalog, defaultConnectionId: first.id, create })
  const input = turn(second, 'run-second')
  const admission = await routing.admit(input)
  catalog.upsert({ ...second, endpoint: 'https://changed.example.test', updatedAt: '2026-10-11T12:01:00.000Z' })
  for await (const _ of routing.streamTurn(input)) { /* drain */ }
  await routing.cancelRun({ runId: input.runId, operationId: 'operation-cancel' })
  const receipt = createAdmissionReceipt({ ...input, turnId: input.turnId!, conversationId: 'conversation-test', branchId: 'branch-test', admittedAt: at, capabilities: UNKNOWN_RUN_CAPABILITIES, materializationReceipt: admission.materializationReceipt })
  const restarted = new ConnectionRoutingExecutionPort({ connections: new ConnectionRegistry([first, second]), defaultConnectionId: first.id, create })
  await restarted.status({ runId: input.runId, receipt })
  for await (const _ of restarted.reconnect({ runId: input.runId, receipt, signal: input.signal })) { /* drain */ }
  assert.deepEqual(observed, [`admit:${second.id}`, `dispatch:${second.id}`, `cancel:${second.id}`, `status:${second.id}`, `replay:${second.id}`])
  const changed = new ConnectionRoutingExecutionPort({ connections: catalog, defaultConnectionId: first.id, create })
  await assert.rejects(changed.status({ runId: input.runId, receipt }), /connection changed/u)
  await assert.rejects(routing.admit({ ...input, connectionId: first.id }), /another connection/u)
})

test('exec-only adapters refuse full-profile execution and transfer before provider create', async () => {
  const record = connection('first')
  let creates = 0
  let transfers = 0
  const capabilities = execOnlyEnvironmentCapabilities({ read: false, write: false, exec: false, git: false, upload: false, download: false })
  const provider: AgentEnvironmentProvider = { name: 'same-provider', capabilities: () => capabilities, async create() { creates += 1; throw new Error('must not allocate') }, contextTransfer: { async lookup() { return undefined }, async transfer() { transfers += 1; throw new Error('must not transfer') } } }
  const production = createProductionComposition({ profile, connections: [record], connectionId: record.id, connectionOptions: { ...await credentialsFor([record]), providerRegistryFactory: () => createAgentEnvironmentProviderRegistry([provider]) } })
  await assert.rejects(async () => production.execution.admit?.(turn(record, 'run-unsupported')), /complete AgentProfile/u)
  assert.equal(await production.execution.context?.supports?.({ runner: 'pi', provider: 'same-provider', sessionId: 'session-destination', runId: 'run-destination', executionId: 'execution-destination', profileDigest: `sha256:${'a'.repeat(64)}` }, { connectionId: record.id }), false)
  assert.equal(creates, 0)
  assert.equal(transfers, 0)
})

test('legacy receipts retain their saved connection and unknown recovery fails closed', async () => {
  const first = connection('first')
  const second = connection('second')
  let selected: string | undefined
  const routing = new ConnectionRoutingExecutionPort({ connections: new ConnectionRegistry([first, second]), defaultConnectionId: first.id, create: (record) => ({ async *streamTurn() {}, async status() { selected = record.id; return null } }) })
  const receipt = createAdmissionReceipt({ ...turn(second, 'run-legacy'), turnId: 'turn-legacy', conversationId: 'conversation-test', branchId: 'branch-test', admittedAt: at, capabilities: UNKNOWN_RUN_CAPABILITIES })
  await routing.status({ runId: 'run-legacy', receipt })
  assert.equal(selected, second.id)
  await assert.rejects(routing.status({ runId: 'run-unbound' }), /admitted connection identity/u)
})
