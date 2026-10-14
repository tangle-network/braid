import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type AgentProfile,
  type ContextTransferRequest,
  canonicalAgentProfileDigest,
  createContextTransferRequest,
  defineAgentProfile,
  portableContextPlanDigest,
  portableConversationContextDigest,
} from '@tangle-network/agent-interface'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import { assertPersistablePayload } from '../src/adapters/storage/sqlite-crypto.js'
import { toJson } from '../src/app/storage-journal-support.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import {
  createConversationId,
  createEventId,
  createRunId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import { persistedContextTransferRequest } from '../src/domain/portable-context-persistence.js'
import { MAX_CONVERSATION_IMPORT_EVENT_BYTES, redactBraidEvent } from '../src/domain/redaction.js'
import { credentialRef } from '../src/ports/credentials.js'

const at = '2026-10-11T12:00:00.000Z'
function requestWith(
  profileOverrides: Partial<AgentProfile> = {},
  text: string | readonly string[] = 'Retain this exact context',
): ContextTransferRequest {
  const profile = defineAgentProfile({ name: 'Exact handoff', harness: 'pi', ...profileOverrides })
  const source = {
    source: {
      runId: 'run-source',
      messageId: 'message-source',
      provider: 'local',
      environmentId: 'environment-source',
      sessionId: 'session-source',
      executionId: 'execution-source',
      requestDigest: `sha256:${'a'.repeat(64)}` as const,
    },
    completeness: 'complete' as const,
    messages: [
      {
        id: 'message-source',
        role: 'user' as const,
        parts: (typeof text === 'string' ? [text] : text).map((text) => ({
          type: 'text' as const,
          text,
        })),
        timestamp: at,
      },
    ],
    attachments: [],
  }
  const context = { ...source, digest: portableConversationContextDigest(source) }
  const material = {
    planId: 'plan-persisted-context',
    source: context,
    context,
    destination: {
      provider: 'target',
      runner: 'pi',
      environmentId: 'environment-target',
      sessionId: 'session-target',
      runId: 'run-target',
      executionId: 'execution-target',
      profileDigest: canonicalAgentProfileDigest(profile),
    },
    messages: [
      {
        messageId: 'message-source',
        action: 'include' as const,
        parts: (typeof text === 'string' ? [text] : text).map((_, partIndex) => ({
          partIndex,
          action: 'include' as const,
        })),
      },
    ],
    requiresAcceptance: false,
    estimatedTokens: 17,
  }
  const plan = { ...material, digest: portableContextPlanDigest(material) }
  return createContextTransferRequest({
    operationId: 'operation-context',
    profile,
    plan,
    acceptance: { planDigest: plan.digest, acceptedAt: at, acceptedBy: 'policy' },
  })
}

function events(request: ContextTransferRequest) {
  return [
    { kind: 'run.requested', receipt: { requested: { portableContextTransferRequest: request } } },
    {
      kind: 'operation.updated',
      operation: { kind: 'conversation-fork', result: { kind: 'handoff', request } },
    },
  ]
}

test('canonical request survives both journal wrappers exactly with its typed numeric estimate', () => {
  const request = requestWith()
  assert.deepEqual(persistedContextTransferRequest(request), request)
  for (const event of events(request)) {
    assert.deepEqual(redactBraidEvent(event), event)
    assertPersistablePayload(toJson({ __braidEvent: redactBraidEvent(event) }))
    assert(
      Buffer.byteLength(JSON.stringify(redactBraidEvent(event))) <=
        MAX_CONVERSATION_IMPORT_EVENT_BYTES,
    )
  }
})

for (const [name, request] of [
  ['secret field', () => requestWith({ metadata: { apiKey: 'CANARY_PRIVATE_VALUE' } })],
  [
    'typed secret answer',
    () =>
      requestWith({
        metadata: {
          answerSpec: { fields: [{ name: 'code', type: 'secret' }] },
          answers: { code: 'CANARY_PRIVATE_VALUE' },
        },
      }),
  ],
  ['secret text', () => requestWith({}, 'Authorization: Bearer CANARY_PRIVATE_VALUE')],
  [
    'secret designation',
    () => requestWith({ metadata: { containsSecret: true, value: 'CANARY_PRIVATE_VALUE' } }),
  ],
  ['noncanonical estimate', () => requestWith({ metadata: { estimatedTokens: 17 } })],
  [
    'depth overflow',
    () =>
      requestWith({
        metadata: { nested: { a: { b: { c: { d: { e: { f: { g: { h: 'too deep' } } } } } } } } },
      }),
  ],
  [
    'byte overflow',
    () =>
      requestWith(
        {},
        Array.from({ length: 8 }, () => 'x'.repeat(10_000)),
      ),
  ],
] as const) {
  test(`canonical request refuses ${name} instead of changing its commitment`, () => {
    const value = request()
    const digest = canonicalDigest(value)
    assert.throws(
      () => persistedContextTransferRequest(value),
      /redaction|truncation|limit|Secret-designated/,
    )
    for (const event of events(value)) assert.throws(() => redactBraidEvent(event))
    assert.equal(canonicalDigest(value), digest)
  })
}

test('canonical request recognition cannot exempt token lookalikes or secret parents', () => {
  const request = requestWith()
  for (const invalid of [
    { ...request, plan: { ...request.plan, estimatedTokens: 'CANARY_PRIVATE_VALUE' } },
    { ...request, plan: { ...request.plan, estimatedTokens: -1 } },
    { ...request, requestDigest: `sha256:${'b'.repeat(64)}` },
    { ...request, extra: 'unrecognized' },
  ]) {
    assert.throws(() => persistedContextTransferRequest(invalid))
    for (const event of events(invalid as ContextTransferRequest))
      assert.throws(() => assertPersistablePayload(toJson({ __braidEvent: event })))
  }
  for (const event of events(request)) {
    assert.throws(
      () => assertPersistablePayload(toJson({ containsSecret: true, __braidEvent: event })),
      /Secret-bearing/,
    )
    assert.throws(
      () =>
        assertPersistablePayload(
          toJson({ __braidEvent: { ...event, accessToken: 'CANARY_PRIVATE_VALUE' } }),
        ),
      /Secret-bearing/,
    )
  }
  for (const payload of [
    { estimatedTokens: 17 },
    {
      __braidEvent: {
        kind: 'unrecognized',
        receipt: { requested: { portableContextTransferRequest: request } },
      },
    },
    {
      __braidEvent: {
        kind: 'operation.updated',
        operation: { kind: 'connection-change', result: { kind: 'handoff', request } },
      },
    },
  ])
    assert.throws(() => assertPersistablePayload(toJson(payload)), /Secret-bearing/)
  const arbitrary = { estimatedTokens: 17, accessToken: 'CANARY_PRIVATE_VALUE' }
  assert.deepEqual(redactBraidEvent(arbitrary), {
    estimatedTokens: '[redacted]',
    accessToken: '[redacted]',
  })
})

test('SQLite rejects canonical-path secret canaries without writing them, including after reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-canonical-secret-'))
  const options = {
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    databaseKeyRef: credentialRef('cred:v1:canonical-secret-test'),
  }
  let storage = await openSqliteStorage(options)
  try {
    const request = requestWith()
    const malformed = {
      ...request,
      plan: { ...request.plan, estimatedTokens: 'CANARY_PRIVATE_VALUE' },
    }
    for (const event of [
      ...events(malformed as unknown as ContextTransferRequest),
      ...events(requestWith({ metadata: { apiKey: 'CANARY_PRIVATE_VALUE' } })),
    ]) {
      await assert.rejects(() =>
        storage.append([
          {
            workspaceId: createWorkspaceId('workspace-secret-test'),
            conversationId: createConversationId('conversation-secret-test'),
            runId: createRunId('run-secret-test'),
            eventId: createEventId('event-secret-test'),
            sequence: 1,
            kind: event.kind,
            payload: toJson({ __braidEvent: event }),
            occurredAt: at,
          },
        ]),
      )
      assert.equal((await storage.events({})).length, 0)
    }
    await storage.close()
    storage = await openSqliteStorage(options)
    assert.equal((await storage.events({})).length, 0)
  } finally {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  }
})
