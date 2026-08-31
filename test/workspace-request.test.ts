import assert from 'node:assert/strict'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { exactAdmissionRequestDigest } from '../src/app/run-admission-request.js'
import { snapshotRunExecution } from '../src/app/run-execution-snapshot.js'
import { retainedExecutionRecoveryContext } from '../src/app/run-recovery-context.js'
import {
  compactWorkspaceRepositoryUrl,
  snapshotWorkspaceRequest,
  workspaceRequestDigest,
  workspaceRequestErrorMessage,
} from '../src/app/workspace-request.js'
import type { RunRecord } from '../src/domain/entities.js'
import { createAdmissionReceipt } from '../src/domain/receipts.js'
import { initialState } from '../src/domain/state.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecuteTurnInput } from '../src/ports/execution.js'

const validRequest = {
  repoUrl: 'https://github.com/acme/repository',
  gitRef: 'main',
  cwd: 'src',
} as const

function thrownMessage(request: unknown): string {
  try {
    snapshotWorkspaceRequest(request as never)
    return ''
  } catch (error) {
    return workspaceRequestErrorMessage(error)
  }
}

test('workspace requests use the canonical schema and immutable snapshots', () => {
  assert.equal(snapshotWorkspaceRequest({}), undefined)
  assert.deepEqual(snapshotWorkspaceRequest({ environment: 'universal' }), {
    environment: 'universal',
  })
  assert.deepEqual(snapshotWorkspaceRequest({ image: 'ubuntu:24.04' }), {
    image: 'ubuntu:24.04',
  })
  assert.deepEqual(snapshotWorkspaceRequest({ cwd: './src' }), { cwd: 'src' })
  const input = {
    ...validRequest,
    providerOptions: {},
  } as { repoUrl: string; gitRef: string; cwd: string; providerOptions: Record<string, never> }
  const snapshot = snapshotWorkspaceRequest(input)
  const digestBeforeMutation = workspaceRequestDigest(input)
  assert.deepEqual(snapshot, validRequest)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.throws(() => {
    ;(snapshot as { cwd: string }).cwd = '/mutated'
  }, TypeError)

  input.cwd = '/changed-after-snapshot'
  assert.equal(snapshot?.cwd, validRequest.cwd)
  assert.equal(digestBeforeMutation, workspaceRequestDigest(snapshot))
})

test('provider options are never persisted, even when the canonical schema accepts them', () => {
  assert.equal(
    thrownMessage({ ...validRequest, providerOptions: { imagePullSecret: 'secret-ref' } }),
    'providerOptions are not persisted',
  )
})

test('canonical workspace validation reports bounded actionable messages', () => {
  assert.equal(thrownMessage({ gitRef: 'main' }), 'gitRef requires repoUrl')
  assert.equal(
    thrownMessage({ repoUrl: 'http://github.com/acme/repository' }),
    'repoUrl must use HTTPS',
  )
  assert.equal(
    thrownMessage({ repoUrl: 'https://user:password@github.com/acme/repository' }),
    'repoUrl must not contain credentials',
  )
  assert.equal(
    thrownMessage({ repoUrl: 'https://github.com/acme/repository?token=secret' }),
    'repoUrl must not contain credentials',
  )
  assert.equal(
    thrownMessage({ repoUrl: 'https://github.com/acme/repository?ref=main' }),
    'repoUrl must not contain query data',
  )
  assert.equal(
    thrownMessage({ repoUrl: 'https://github.com/acme/repository#main' }),
    'repoUrl must not contain fragment data',
  )
  assert.equal(
    thrownMessage({ repoUrl: 'https://127.0.0.1/acme/repository' }),
    'repoUrl must use a public hostname',
  )
  assert.equal(
    thrownMessage({ repoUrl: 'https://[::1]/acme/repository' }),
    'repoUrl must use a public hostname',
  )
  assert.equal(
    thrownMessage({ repoUrl: 'https://[::ffff:127.0.0.1]/acme/repository' }),
    'repoUrl must use a public hostname',
  )
  for (const host of ['192.31.196.1', '192.52.193.1', '192.88.99.1', '192.175.48.1']) {
    assert.equal(
      thrownMessage({ repoUrl: `https://${host}/acme/repository` }),
      'repoUrl must use a public hostname',
    )
  }
  assert.equal(thrownMessage({ repoUrl: 'https://github.com/acme/repository' }), '')
})

test('portable Sandbox cwd failures use the start-in field message', () => {
  for (const message of [
    'Workspace cwd must be relative',
    'Workspace cwd must use POSIX separators',
    'Workspace cwd cannot leave the workspace root',
    'Workspace cwd cannot contain control characters',
  ]) {
    assert.equal(
      workspaceRequestErrorMessage(new Error(message)),
      'start in must be a repository-relative path',
    )
  }
})

test('portable Sandbox cwd validation rejects paths that leave the repository', () => {
  for (const cwd of [
    '/workspace/src',
    '../outside',
    'src/../../outside',
    'src\\win',
    'src\u0000bad',
  ]) {
    assert.equal(thrownMessage({ cwd }), 'start in must be a repository-relative path')
  }
})

test('workspace display strips URL credentials and query material', () => {
  assert.equal(
    compactWorkspaceRepositoryUrl(
      'https://user:password@github.com/acme/repository?token=secret#fragment',
    ),
    'https://github.com/acme/repository',
  )
  assert.equal(compactWorkspaceRepositoryUrl('not a URL'), undefined)
})

test('admission binds workspace selection and local root without receipt shadow fields', () => {
  const profile = defineAgentProfile({
    name: 'workspace admission',
    harness: 'pi',
    model: { default: 'openai/gpt-5' },
  })
  const state = { ...initialState(profile), workspace: '/local/repository' }
  const snapshot = snapshotRunExecution(
    { operationId: 'operation-workspace-admission', text: 'inspect the repository' },
    state,
    profile,
    'connection-tangle-sandbox',
    undefined,
    validRequest,
  )
  const workspaceRequest = snapshot.workspaceRequest
  assert.ok(workspaceRequest)
  const connectionId = 'connection-tangle-sandbox'
  const workspaceRoot = '/local/repository'
  const input: ExecuteTurnInput = {
    operationId: snapshot.operationId,
    runId: 'run-workspace-admission',
    text: snapshot.text,
    profile: snapshot.profile,
    connectionId,
    workspaceRequest,
    workspaceRoot,
    signal: new AbortController().signal,
  }
  const receipt = createAdmissionReceipt({
    runId: input.runId,
    turnId: 'turn-workspace-admission',
    operationId: input.operationId,
    conversationId: snapshot.conversationId,
    branchId: snapshot.branchId,
    admittedAt: '2026-08-30T00:00:00.000Z',
    profile: input.profile,
    connectionId,
    workspaceRequest,
    workspaceRoot,
    text: input.text,
    capabilities: DEFAULT_RUN_CAPABILITIES,
  })

  assert.deepEqual(receipt.requested.workspaceRequest, validRequest)
  assert.equal(receipt.requested.workspaceRoot, workspaceRoot)
  assert.equal(Object.hasOwn(receipt, 'workspaceRequest'), false)
  assert.equal(Object.hasOwn(receipt, 'workspaceRoot'), false)
  const recovered = retainedExecutionRecoveryContext(
    { receipt } as unknown as RunRecord,
    '/current/repository',
  )
  assert.deepEqual(recovered.workspaceRequest, validRequest)
  assert.equal(recovered.workspaceRoot, '/local/repository')

  const legacyReceipt = createAdmissionReceipt({
    runId: input.runId,
    turnId: 'turn-workspace-legacy',
    operationId: input.operationId,
    conversationId: snapshot.conversationId,
    branchId: snapshot.branchId,
    admittedAt: '2026-08-30T00:00:00.000Z',
    profile: input.profile,
    connectionId: 'connection-tangle-sandbox',
    text: input.text,
    capabilities: DEFAULT_RUN_CAPABILITIES,
  })
  const legacyRecovery = retainedExecutionRecoveryContext(
    { receipt: legacyReceipt } as unknown as RunRecord,
    '/current/repository',
  )
  assert.equal(legacyRecovery.workspaceRequest, undefined)
  assert.equal(legacyRecovery.workspaceRoot, '/current/repository')
  const digest = exactAdmissionRequestDigest(input, snapshot.conversationId, snapshot.branchId)
  assert.notEqual(
    digest,
    exactAdmissionRequestDigest(
      { ...input, workspaceRoot: '/another/local/repository' },
      snapshot.conversationId,
      snapshot.branchId,
    ),
  )
  assert.notEqual(
    digest,
    exactAdmissionRequestDigest(
      { ...input, workspaceRequest: { ...validRequest, cwd: 'other' } },
      snapshot.conversationId,
      snapshot.branchId,
    ),
  )
})
