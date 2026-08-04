import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import type { ConnectionCapabilityReport } from '../src/adapters/connections/production-connection-types.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { operationTestResult } from '../src/app/connection-action-support.js'
import { MemoryJournal } from '../src/app/journal.js'
import { createProfileRecord } from '../src/app/profiles.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import { FixedClock } from '../src/ports/clock.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'

const at = '2026-08-03T00:00:00.000Z'

function connection(): ConnectionRecord {
  return {
    id: createConnectionId('connection-action-test'),
    kind: 'cli-bridge',
    name: 'action test bridge',
    endpoint: 'http://127.0.0.1:3344',
    providerOptions: { transport: 'local' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}

function capabilities(connectionId: ConnectionRecord['id']): ConnectionCapabilityReport {
  return {
    connectionId,
    kind: 'cli-bridge',
    runtime: {
      backend: 'chat',
      streaming: { live: true, replay: true, detach: false, turnIdempotency: true },
      sessions: { continue: true, list: false, messages: false },
      interactions: { originate: false, respond: false },
    },
    providerMethods: { create: true, get: false, list: false, respondToInteraction: false },
    actions: {
      stream: true,
      replay: true,
      detach: false,
      'continue-session': true,
      'list-sessions': false,
      'session-messages': false,
      checkpoint: false,
      fork: false,
      placement: true,
      usage: true,
      'respond-interaction': false,
    },
  }
}

function line(value: object): string {
  return `${JSON.stringify(value)}\n`
}

function responseFor(responses: readonly BraidResponse[], requestId: string): BraidResponse {
  const response = responses.find(
    (candidate) => candidate.type === 'ack' && candidate.requestId === requestId,
  )
  assert(
    response,
    `missing acknowledgement for ${requestId}; responses=${responses
      .map((candidate) => {
        if (candidate.type === 'event') return `event::${JSON.stringify(candidate)}`
        return `${candidate.type}:${candidate.requestId ?? ''}:${JSON.stringify(candidate)}`
      })
      .join(',')}`,
  )
  return response
}

function outcomeWithoutReplay(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  const { replayed: _replayed, ...outcome } = value as Record<string, unknown>
  return outcome
}

test('JSONL profile and connection actions use durable replay and local list paths', async () => {
  const profileA = defineAgentProfile({
    name: 'Action profile A',
    harness: 'pi',
    model: { default: 'fixture/action-a' },
  })
  const profileB = defineAgentProfile({
    name: 'Action profile B',
    harness: 'pi',
    model: { default: 'fixture/action-b' },
  })
  const secretProfile = defineAgentProfile({
    name: 'Action profile with inline secret',
    harness: 'pi',
    model: { default: 'fixture/action-secret' },
    metadata: { apiKey: 'ACTION-SECRET-CANARY' },
  })
  const sourceA = createProfileRecord(
    { kind: 'inline', reference: 'action:a', label: 'Action A', writable: false, trusted: true },
    profileA,
  )
  const sourceB = createProfileRecord(
    { kind: 'inline', reference: 'action:b', label: 'Action B', writable: false, trusted: true },
    profileB,
  )
  const sourceSecret = createProfileRecord(
    {
      kind: 'inline',
      reference: 'action:secret',
      label: 'Action secret profile',
      writable: false,
      trusted: true,
    },
    secretProfile,
  )
  const record = connection()
  let capabilityCalls = 0
  let healthCalls = 0
  let modelCalls = 0
  let listDidNotProbe = false
  const journal = new MemoryJournal(new FixedClock())
  const app = createBraidApplication({
    fixture: 'deterministic',
    profile: profileA,
    journal,
    effectStorage: journal,
  })
  const controller = createApplicationUiController(app, {}, undefined, {
    profiles: [sourceA, sourceB, sourceSecret],
    connections: [record],
    probeFor: () => ({
      capabilities: async () => {
        capabilityCalls += 1
        return capabilities(record.id)
      },
      health: async () => {
        healthCalls += 1
        return { status: 'healthy', checkedAt: at }
      },
      verifyModel: async (model) => {
        modelCalls += 1
        return { model, status: 'verified', checkedAt: at }
      },
    }),
  })
  const responses: BraidResponse[] = []
  let output = ''
  const profilePathRoot = await mkdtemp(join(tmpdir(), 'braid-profile-actions-'))
  const profilePath = join(profilePathRoot, 'saved.json')
  try {
    async function* input(): AsyncGenerator<string> {
      yield line({
        version: 1,
        requestId: 'actions-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      })
      yield line({
        version: 1,
        requestId: 'actions-list-profiles',
        command: 'list_profiles',
        params: {},
      })
      yield line({
        version: 1,
        requestId: 'actions-validate-profile',
        command: 'validate_profile',
        params: { ref: sourceB.id },
      })
      yield line({
        version: 1,
        requestId: 'actions-invalid-profile',
        operationId: 'op-invalid-profile',
        command: 'save_profile',
        params: { ref: profilePath, profile: { unknownField: true } },
      })
      yield line({
        version: 1,
        requestId: 'actions-select-profile',
        operationId: 'op-select-profile',
        command: 'select_profile',
        params: { ref: sourceB.id, expectedRevision: 1 },
      })
      yield line({
        version: 1,
        requestId: 'actions-select-profile-replay',
        operationId: 'op-select-profile',
        command: 'select_profile',
        params: { ref: sourceB.id, expectedRevision: 1 },
      })
      yield line({
        version: 1,
        requestId: 'actions-stale-profile',
        operationId: 'op-stale-profile',
        command: 'select_profile',
        params: { ref: sourceA.id, expectedRevision: 1 },
      })
      yield line({
        version: 1,
        requestId: 'actions-unknown-profile',
        command: 'validate_profile',
        params: { ref: 'profile:missing' },
      })
      yield line({
        version: 1,
        requestId: 'actions-select-inline-secret',
        operationId: 'op-select-inline-secret',
        command: 'select_profile',
        params: { ref: sourceSecret.id },
      })
      yield line({
        version: 1,
        requestId: 'actions-list-connections',
        command: 'list_connections',
        params: {},
      })
      listDidNotProbe = capabilityCalls === 0 && healthCalls === 0 && modelCalls === 0
      yield line({
        version: 1,
        requestId: 'actions-select-connection',
        operationId: 'op-select-connection',
        command: 'select_connection',
        params: { connectionId: record.id },
      })
      yield line({
        version: 1,
        requestId: 'actions-test-connection',
        operationId: 'op-test-connection',
        command: 'test_connection',
        params: { connectionId: record.id },
      })
      yield line({
        version: 1,
        requestId: 'actions-test-connection-replay',
        operationId: 'op-test-connection',
        command: 'test_connection',
        params: { connectionId: record.id },
      })
      yield line({
        version: 1,
        requestId: 'actions-save-profile',
        operationId: 'op-save-profile',
        command: 'save_profile',
        params: { ref: profilePath, profile: profileB },
      })
      yield line({
        version: 1,
        requestId: 'actions-save-inline-secret',
        operationId: 'op-save-inline-secret',
        command: 'save_profile',
        params: { ref: profilePath, profile: secretProfile },
      })
      await rm(profilePath)
      yield line({
        version: 1,
        requestId: 'actions-save-profile-replay',
        operationId: 'op-save-profile',
        command: 'save_profile',
        params: { ref: profilePath, profile: profileB },
      })
    }
    const code = await runRpc(controller, input(), {
      write: (chunk) => {
        output += chunk
        return true
      },
    })
    responses.push(
      ...output
        .trim()
        .split('\n')
        .map((value) => JSON.parse(value) as BraidResponse),
    )
    assert.equal(code, 0)
    const testOperation = app
      .state()
      .operations.find((operation) => operation.id === 'op-test-connection')
    assert(testOperation)
    assert(operationTestResult(testOperation), JSON.stringify(testOperation.result))
    assert.equal(
      JSON.stringify(testOperation.result).includes('credentialConfigured'),
      false,
      'durable connection results must not persist credential-named UI metadata',
    )
    const profileList = responseFor(responses, 'actions-list-profiles')
    assert.equal(profileList.type, 'ack')
    assert.equal(
      (profileList.result as { profiles: readonly unknown[] }).profiles.length >= 2,
      true,
    )
    const invalid = responses.find(
      (response) => response.type === 'error' && response.requestId === 'actions-invalid-profile',
    )
    assert.equal(invalid?.type, 'error')
    if (invalid?.type === 'error') assert.equal(invalid.code, 'PROFILE_INVALID')
    const selected = responseFor(responses, 'actions-select-profile')
    const selectedReplay = responseFor(responses, 'actions-select-profile-replay')
    assert.equal(selected.type, 'ack')
    assert.equal(selectedReplay.type, 'ack')
    if (selected.type === 'ack' && selectedReplay.type === 'ack') {
      assert.equal(selected.replayed, false)
      assert.equal(selectedReplay.replayed, true)
      assert.deepEqual(
        outcomeWithoutReplay(selected.result),
        outcomeWithoutReplay(selectedReplay.result),
      )
    }
    const stale = responses.find(
      (response) => response.type === 'error' && response.requestId === 'actions-stale-profile',
    )
    assert.equal(stale?.type, 'error')
    if (stale?.type === 'error') assert.equal(stale.code, 'STALE_REVISION')
    const unknown = responses.find(
      (response) => response.type === 'error' && response.requestId === 'actions-unknown-profile',
    )
    assert.equal(unknown?.type, 'error')
    if (unknown?.type === 'error') assert.equal(unknown.code, 'PROFILE_NOT_FOUND')
    const secretSelection = responses.find(
      (response) =>
        response.type === 'error' && response.requestId === 'actions-select-inline-secret',
    )
    assert.equal(secretSelection?.type, 'error')
    if (secretSelection?.type === 'error') assert.equal(secretSelection.code, 'PROFILE_INVALID')
    assert.notEqual(app.state().selectedProfileId, sourceSecret.id)
    assert.equal(listDidNotProbe, true)
    const tested = responseFor(responses, 'actions-test-connection')
    const testedReplay = responseFor(responses, 'actions-test-connection-replay')
    assert.equal(tested.type, 'ack')
    assert.equal(testedReplay.type, 'ack')
    if (tested.type === 'ack' && testedReplay.type === 'ack') {
      assert.equal(tested.replayed, false)
      assert.equal(testedReplay.replayed, true)
      assert.deepEqual(
        outcomeWithoutReplay(tested.result),
        outcomeWithoutReplay(testedReplay.result),
      )
    }
    assert.equal(capabilityCalls, 1)
    assert.equal(healthCalls, 1)
    assert.equal(modelCalls, 1)
    const savedReplay = responseFor(responses, 'actions-save-profile-replay')
    assert.equal(savedReplay.type, 'ack')
    if (savedReplay.type === 'ack') assert.equal(savedReplay.replayed, true)
    const secretSave = responses.find(
      (response) =>
        response.type === 'error' && response.requestId === 'actions-save-inline-secret',
    )
    assert.equal(secretSave?.type, 'error')
    if (secretSave?.type === 'error') assert.equal(secretSave.code, 'PROFILE_INVALID')
    assert.equal(
      app.state().operations.some((operation) => operation.id === 'op-save-inline-secret'),
      false,
    )
    assert.equal(JSON.stringify(app.events()).includes('ACTION-SECRET-CANARY'), false)
    await assert.rejects(readFile(profilePath))
  } finally {
    await rm(profilePathRoot, { recursive: true, force: true })
  }
})
