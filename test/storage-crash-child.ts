import { join } from 'node:path'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import {
  createConversationId,
  createEventId,
  createOperationId,
  createRunId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import {
  CredentialError,
  type CredentialPort,
  type CredentialStoreInput,
  credentialRef,
  type SecretHandle,
} from '../src/ports/credentials.js'
import type { EffectRecord } from '../src/ports/effect-storage.js'
import { FileCredentialStore } from './support/file-credentials.js'

const root = required('CRASH_ROOT')
const databasePath = required('CRASH_DATABASE')
const boundary = required('CRASH_BOUNDARY')
const action = required('CRASH_ACTION')
const credentials = new FileCredentialStore(join(root, 'credentials'))

class FailingRedactionCredentialStore implements CredentialPort {
  constructor(private readonly delegate: CredentialPort) {}

  available(): Promise<boolean> {
    return this.delegate.available()
  }

  store(input: CredentialStoreInput): Promise<import('../src/ports/credentials.js').CredentialRef> {
    if (input.ref?.includes('content-redacted')) {
      throw new CredentialError('CREDENTIAL_WRITE_FAILED', 'Injected redaction key write failure')
    }
    return this.delegate.store(input)
  }

  resolve(ref: import('../src/ports/credentials.js').CredentialRef): Promise<SecretHandle> {
    return this.delegate.resolve(ref)
  }

  remove(ref: import('../src/ports/credentials.js').CredentialRef): Promise<void> {
    return this.delegate.remove(ref)
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const workspaceId = createWorkspaceId('workspace-crash')
const conversationId = createConversationId('conversation-crash')

function event(sequence: number, eventId: string, terminal = false) {
  return {
    workspaceId,
    conversationId,
    runId: createRunId('run-crash'),
    eventId: createEventId(eventId),
    sequence,
    kind: terminal ? 'run.finished' : 'run.text.delta',
    payload: { text: `crash-boundary-${sequence}` },
    occurredAt: '2026-08-02T00:00:00.000Z',
    receivedAt: '2026-08-02T00:00:00.000Z',
    terminal,
  } as const
}

function effect(): EffectRecord {
  return {
    operationId: 'op-crash',
    effectKind: 'test.effect',
    requestDigest: 'a'.repeat(64),
    status: 'pending',
    attempt: 1,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    metadata: { action: 'crash' },
  }
}

const crashOperationRequest = { text: 'crash' } as const

function mutation(kind: string, request: import('../src/ports/storage.js').JsonValue = {}) {
  return {
    operationId: createOperationId(`op-${kind}`),
    kind,
    request,
    requestDigest: canonicalDigest(request),
  }
}

const storage = await openSqliteStorage({
  path: databasePath,
  workspaceRoot: root,
  credentialStore:
    action === 'redaction-prepare-cleanup'
      ? new FailingRedactionCredentialStore(credentials)
      : credentials,
  databaseKeyRef: credentialRef('cred:v1:test-crash-database'),
  durableBoundaryHook: (current) => {
    if (current === boundary) process.kill(process.pid, 'SIGKILL')
  },
})

try {
  switch (action) {
    case 'append':
      await storage.append([event(1, 'event-crash-1')])
      break
    case 'rebuild':
      await storage.rebuild(mutation('rebuild'))
      break
    case 'operation-reserve':
      await storage.reserveOperation({
        operationId: createOperationId('op-crash'),
        kind: 'send',
        request: crashOperationRequest,
        requestDigest: canonicalDigest(crashOperationRequest),
      })
      break
    case 'operation-reserve-replay':
      await storage.reserveOperation({
        operationId: createOperationId('op-crash'),
        kind: 'send',
        request: crashOperationRequest,
        requestDigest: canonicalDigest(crashOperationRequest),
      })
      break
    case 'operation-reserve-conflict':
      await storage.reserveOperation({
        operationId: createOperationId('op-crash'),
        kind: 'send',
        request: { text: 'changed' },
        requestDigest: canonicalDigest({ text: 'changed' }),
      })
      break
    case 'operation-complete':
    case 'operation-complete-replay':
      await storage.completeOperation({
        operationId: createOperationId('op-crash'),
        requestDigest: canonicalDigest(crashOperationRequest),
        status: 'terminal',
        result: { complete: true },
      })
      break
    case 'operation-complete-conflict':
      await storage.completeOperation({
        operationId: createOperationId('op-crash'),
        requestDigest: 'b'.repeat(64),
        status: 'terminal',
      })
      break
    case 'operation-conflict':
      await storage.recordOperationConflict({
        operationId: createOperationId('op-crash'),
        requestDigest: canonicalDigest(crashOperationRequest),
        attemptedDigest: 'c'.repeat(64),
      })
      break
    case 'effect':
      storage.appendEffect(effect())
      break
    case 'effect-reserve':
      storage.reserveEffect(effect())
      break
    case 'effect-reserve-replay':
      storage.reserveEffect(effect())
      break
    case 'effect-reserve-conflict':
      storage.reserveEffect({ ...effect(), requestDigest: 'b'.repeat(64) })
      break
    case 'retention':
      await storage.applyRetention({
        before: '2026-08-03T00:00:00.000Z',
        conversationId,
        operation: mutation('retention', { before: '2026-08-03T00:00:00.000Z', conversationId }),
      })
      break
    case 'redaction':
    case 'redaction-prepare-cleanup':
      await storage.redact({
        conversationId,
        eventId: createEventId('event-crash-1'),
        reason: 'crash test',
        operation: mutation('redaction', {
          conversationId,
          eventId: createEventId('event-crash-1'),
          reasonDigest: canonicalDigest('crash test'),
        }),
      })
      break
    case 'destruction':
      await storage.destroyConversation({
        conversationId,
        reason: 'crash test',
        operation: mutation('destruction', {
          conversationId,
          reasonDigest: canonicalDigest('crash test'),
        }),
      })
      break
    case 'backup':
      await storage.backup({
        path: join(root, 'crash-backup.sqlite'),
        operation: mutation('backup', { path: join(root, 'crash-backup.sqlite') }),
      })
      break
    case 'restore':
      await storage.restore({
        path: join(root, 'crash-restore-source.sqlite'),
        operation: mutation('restore', { path: join(root, 'crash-restore-source.sqlite') }),
      })
      break
    case 'migration':
    case 'key-reconcile':
      throw new Error(`${action} should have reached its crash boundary while opening storage`)
    default:
      throw new Error(`Unknown crash action ${action}`)
  }
} finally {
  await storage.close()
}
