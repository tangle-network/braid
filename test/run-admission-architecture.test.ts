import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { type AgentProfile, defineAgentProfile } from '@tangle-network/agent-interface'
import {
  admitRun,
  admitRunAsync,
  continueNative,
  pendingAdmissionReceipt,
  runEffectRequest,
  sendRun,
  sendRunAsync,
  validateNativeProof,
} from '../src/app/run-admission.js'
import type {
  AdmissionPort,
  AsyncAdmissionPort,
  NativeContinuationPort,
} from '../src/app/application-ports.js'
import type { RunExecutionSnapshot } from '../src/app/run-execution-snapshot.js'
import { initialState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecutionPort,
  UNKNOWN_RUN_CAPABILITIES,
} from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'

const PROFILE = defineAgentProfile({
  name: 'Architecture test profile',
  description: 'Tests the run admission module boundaries',
  harness: 'pi',
  model: { default: 'fixture/test', reasoningEffort: 'none' },
})

const MODULES = [
  'run-admission.ts',
  'run-admission-request.ts',
  'run-admission-validation.ts',
  'run-admission-receipt.ts',
  'run-admission-dispatch.ts',
  'run-admission-continuation.ts',
] as const

async function repositoryRoot(): Promise<string> {
  const candidates = [new URL('../', import.meta.url), new URL('../../', import.meta.url)]
  for (const candidate of candidates) {
    try {
      await access(new URL('package.json', candidate))
      return candidate.pathname
    } catch {}
  }
  throw new Error('Could not locate the Braid repository root')
}

function idleExecution(overrides: Partial<ExecutionPort> = {}): ExecutionPort {
  return {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(): AsyncIterable<never> {
      yield* []
    },
    ...overrides,
  }
}

function admissionContext(execution: ExecutionPort): AdmissionPort {
  const state = { ...initialState(PROFILE), workspace: '/workspace' }
  return {
    currentState: () => state,
    execution,
    ids: new SequenceIds(),
    clock: new FixedClock(),
  } as unknown as AdmissionPort
}

function executionInput(
  overrides: Partial<{
    readonly operationId: string
    readonly runId: string
    readonly text: string
    readonly profile: Readonly<AgentProfile>
  }> = {},
) {
  return {
    operationId: overrides.operationId ?? 'op-architecture',
    runId: overrides.runId ?? 'run-architecture',
    text: overrides.text ?? 'test admission',
    profile: overrides.profile ?? PROFILE,
    signal: new AbortController().signal,
  }
}

function snapshotInput(): RunExecutionSnapshot {
  return {
    operationId: 'op-request',
    text: 'request payload',
    conversationId: 'conv-1',
    branchId: 'branch-1',
    profile: PROFILE,
    connectionId: 'connection-1',
    workspaceRoot: '/workspace',
    sessionId: 'session-1',
    sessionSource: 'continuation',
  }
}

test('the façade exports stable behavior without owning implementation', async () => {
  const root = await repositoryRoot()
  const sources = new Map(
    await Promise.all(
      MODULES.map(
        async (name) => [name, await readFile(join(root, 'src/app', name), 'utf8')] as const,
      ),
    ),
  )
  const façade = sources.get('run-admission.ts') ?? ''
  assert.doesNotMatch(façade, /^import\s/mu)
  assert.match(façade, /run-admission-request\.js/u)
  assert.match(façade, /run-admission-validation\.js/u)
  assert.match(façade, /run-admission-receipt\.js/u)
  assert.match(façade, /run-admission-dispatch\.js/u)
  assert.match(façade, /run-admission-continuation\.js/u)

  for (const [name, source] of sources) {
    assert.ok(source.split('\n').length < 300, `${name} should stay below 300 lines`)
  }

  const edges = new Map<string, string[]>(MODULES.map((name) => [name, []]))
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/from\s+['"](\.\/run-admission[^'"]+)['"]/gu)) {
      const target = `${match[1]?.replace(/^\.\//u, '').replace(/\.js$/u, '')}.ts`
      if (MODULES.includes(target as (typeof MODULES)[number])) edges.get(name)?.push(target)
    }
  }
  assert.deepEqual(edges.get('run-admission.ts')?.sort(), [
    'run-admission-continuation.ts',
    'run-admission-dispatch.ts',
    'run-admission-receipt.ts',
    'run-admission-request.ts',
    'run-admission-validation.ts',
  ])
  for (const name of MODULES.slice(1)) {
    assert.equal(edges.get(name)?.includes('run-admission.ts'), false, `${name} imports the façade`)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(name: string): void {
    if (visiting.has(name)) throw new Error(`run-admission module cycle includes ${name}`)
    if (visited.has(name)) return
    visiting.add(name)
    for (const target of edges.get(name) ?? []) visit(target)
    visiting.delete(name)
    visited.add(name)
  }
  for (const name of MODULES) visit(name)
})

test('request construction keeps the complete execution snapshot boundary', () => {
  assert.deepEqual(runEffectRequest(snapshotInput()), {
    conversationId: 'conv-1',
    branchId: 'branch-1',
    text: 'request payload',
    profile: PROFILE,
    connectionId: 'connection-1',
    workspaceRoot: '/workspace',
    sessionId: 'session-1',
  })
})

test('sync and async admission preserve capability and pending receipt semantics', async () => {
  const syncContext = admissionContext(idleExecution({ capabilities: { cancel: false } }))
  const syncReceipt = admitRun(
    syncContext,
    executionInput(),
    'conv-1',
    'branch-1',
    undefined,
    'turn-sync',
  )
  assert.equal(syncReceipt.capabilities.controls.cancel, false)
  assert.equal(syncReceipt.admissionStatus, 'admitted')

  const asyncContext = admissionContext(
    idleExecution({
      admit: async () => ({ capabilities: DEFAULT_RUN_CAPABILITIES, warnings: ['ASYNC_WARNING'] }),
    }),
  ) as AsyncAdmissionPort
  const asyncReceipt = await admitRunAsync(
    asyncContext,
    executionInput({ runId: 'run-async' }),
    'conv-1',
    'branch-1',
    undefined,
    'turn-async',
  )
  assert.deepEqual(asyncReceipt.warnings, ['ASYNC_WARNING'])

  const pending = pendingAdmissionReceipt(snapshotInput(), 'run-pending', 'turn-pending')
  assert.equal(pending.admissionStatus, 'pending')
  assert.deepEqual(pending.capabilities, UNKNOWN_RUN_CAPABILITIES)
})

test('native session reuse remains fail-closed at the validation and continuation boundaries', async () => {
  const context = admissionContext(idleExecution())
  assert.throws(
    () =>
      validateNativeProof(context, {
        operationId: 'op-native',
        text: 'reuse',
        sessionId: 'caller-session',
        profile: PROFILE,
      }),
    (error: unknown) => error instanceof Error && error.message.includes('valid native context'),
  )

  const continuationContext = {
    ...context,
    findRun: () => ({
      id: 'run-missing-session',
      providerSessionId: undefined,
      capabilities: DEFAULT_RUN_CAPABILITIES,
    }),
    send: () => {
      throw new Error('send should not be reached')
    },
  } as unknown as NativeContinuationPort
  await assert.rejects(
    () => continueNative(continuationContext, { operationId: 'op-native', text: 'reuse' }),
    (error: unknown) => error instanceof Error && error.message.includes('prove a native session'),
  )
})

test('the public dispatch exports remain callable through the façade', () => {
  assert.equal(typeof sendRun, 'function')
  assert.equal(typeof sendRunAsync, 'function')
  assert.equal(typeof continueNative, 'function')
})
