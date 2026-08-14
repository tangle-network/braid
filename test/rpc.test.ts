import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { runPlain } from '../src/bin/plain.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import { redactSensitiveText } from '../src/domain/secret-sanitizer.js'
import { FixedClock } from '../src/ports/clock.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecutionPort,
  UNKNOWN_RUN_CAPABILITIES,
} from '../src/ports/execution.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { MAX_RPC_LINE_BYTES } from '../src/views/headless/protocol-limits.js'
import { RPC_REPLAY_MAX_BYTES, RPC_REPLAY_MAX_ENTRIES, runRpc } from '../src/views/headless/rpc.js'
import { queryActivity } from '../src/views/shared/semantic-activity.js'
import { queryDetails } from '../src/views/shared/semantic-details.js'
import { queryGraph } from '../src/views/shared/semantic-graph.js'
import { compareSemanticText } from '../src/views/shared/semantic-graph-filters.js'
import { SemanticQueryError } from '../src/views/shared/semantic-query-scope.js'
import type {
  ActivityQueryResult,
  DetailsQueryResult,
  GraphQueryResult,
} from '../src/views/shared/semantic-query-types.js'

async function* requestInput(lines: readonly object[]): AsyncGenerator<string> {
  yield `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

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

function controllerFor(app: ReturnType<typeof createBraidApplication>) {
  return createApplicationUiController(app)
}

function responseWriter(responses: BraidResponse[]): (chunk: string) => boolean {
  return (chunk) => {
    responses.push(JSON.parse(chunk) as BraidResponse)
    return true
  }
}

function resultFor<T>(responses: readonly BraidResponse[], requestId: string): T {
  const response = responses.find(
    (candidate) => candidate.type === 'ack' && candidate.requestId === requestId,
  )
  assert(response && response.type === 'ack', `missing acknowledgement for ${requestId}`)
  assert.notEqual(response.result, undefined, `missing result for ${requestId}`)
  return response.result as T
}

test('JSONL send acknowledges before events and returns final semantic state', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  async function* input(): AsyncGenerator<string> {
    yield `${[
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace', subscribe: true },
      },
      {
        version: 1,
        requestId: 'req-send',
        operationId: 'op-rpc',
        command: 'send',
        params: {
          conversationId: 'conv-1',
          branchId: 'branch-1',
          text: 'hello Braid',
        },
      },
    ]
      .map((request) => JSON.stringify(request))
      .join('\n')}\n`
    await app.waitForIdle()
    yield `${JSON.stringify({
      version: 1,
      requestId: 'req-stop',
      operationId: 'op-stop-1',
      command: 'shutdown',
    })}\n`
  }
  const code = await runRpc(controllerFor(app), input(), {
    write: (chunk) => {
      output += chunk
      return true
    },
  })
  const responses = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
  const sendAck = responses.findIndex(
    (response) => response.type === 'ack' && response.requestId === 'req-send',
  )
  const firstRunEvent = responses.findIndex(
    (response) => response.type === 'event' && response.event.kind === 'run.requested',
  )
  const sendStates = responses.filter(
    (response) => response.type === 'state' && response.requestId === 'req-send',
  )
  const admissionState = sendStates.find(
    (response) =>
      response.type === 'state' && response.projection === 'full' && response.state.activeRunId,
  )
  const finalState = sendStates.at(-1)

  assert.equal(code, 0)
  assert.ok(sendAck >= 0)
  assert.ok(firstRunEvent > sendAck)
  const sendResponse = responses[sendAck]
  assert.equal(sendResponse?.type, 'ack')
  if (sendResponse?.type !== 'ack') assert.fail('missing send acknowledgement')
  assert.equal(admissionState?.type, 'state')
  if (admissionState?.type !== 'state') assert.fail('missing admission state')
  assert.equal(admissionState.projection, 'full')
  if (admissionState.projection !== 'full') assert.fail('expected full admission state')
  assert.equal(admissionState.state.activeRunId, sendResponse.runId)
  assert.equal(finalState?.type, 'state')
  if (finalState?.type !== 'state') assert.fail('missing final state')
  assert.equal(finalState.projection, 'full')
  if (finalState.projection !== 'full') assert.fail('expected full state')
  assert.equal(finalState.state.messages[1]?.text, 'Fixture response through pi: hello Braid')
  assert.equal(finalState.state.runs[0]?.status, 'completed')
})

test('JSONL drives the complete canonical conversation lifecycle', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  const responses: BraidResponse[] = []
  async function* input(): AsyncGenerator<string> {
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-init',
      command: 'initialize',
      params: { workspace: '/workspace' },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-create',
      operationId: 'op-rpc-conversation-create',
      command: 'new_conversation',
      params: { title: 'RPC conversation' },
    })}\n`
    const created = resultFor<{ id: string; activeBranchId: string }>(
      responses,
      'conversation-create',
    )
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-draft',
      operationId: 'op-rpc-conversation-draft',
      command: 'set_draft',
      params: {
        conversationId: created.id,
        branchId: created.activeBranchId,
        text: 'durable JSONL draft',
      },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-draft-replay',
      operationId: 'op-rpc-conversation-draft',
      command: 'set_draft',
      params: {
        conversationId: created.id,
        branchId: created.activeBranchId,
        text: 'durable JSONL draft',
      },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-rename',
      operationId: 'op-rpc-conversation-rename',
      command: 'rename_conversation',
      params: { conversationId: created.id, title: 'Renamed over JSONL' },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-archive',
      operationId: 'op-rpc-conversation-archive',
      command: 'archive_conversation',
      params: { conversationId: created.id, archived: true },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-list',
      command: 'list_conversations',
      params: { query: 'renamed', status: 'archived' },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-restore',
      operationId: 'op-rpc-conversation-restore',
      command: 'archive_conversation',
      params: { conversationId: created.id, archived: false },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-send',
      operationId: 'op-rpc-conversation-send',
      command: 'send',
      params: {
        conversationId: created.id,
        branchId: created.activeBranchId,
        text: 'message boundary',
      },
    })}\n`
    await app.waitForIdle()
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-state',
      command: 'get_state',
    })}\n`
    const state = responses.find(
      (response) => response.type === 'state' && response.requestId === 'conversation-state',
    )
    assert(state && state.type === 'state' && state.projection === 'full')
    const messageId = state.state.messages[0]?.id
    assert(messageId)
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-branch',
      operationId: 'op-rpc-conversation-branch',
      command: 'branch',
      params: {
        conversationId: created.id,
        branchId: created.activeBranchId,
        messageId,
      },
    })}\n`
    const branch = resultFor<{ id: string }>(responses, 'conversation-branch')
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-clone',
      operationId: 'op-rpc-conversation-clone',
      command: 'clone',
      params: { conversationId: created.id, branchId: branch.id, title: 'RPC clone' },
    })}\n`
    const clone = resultFor<{ id: string }>(responses, 'conversation-clone')
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-delete-clone',
      operationId: 'op-rpc-conversation-delete-clone',
      command: 'delete_conversation',
      params: { conversationId: clone.id },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-open',
      operationId: 'op-rpc-conversation-open',
      command: 'open_conversation',
      params: { conversationId: created.id, branchId: created.activeBranchId },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-plan',
      operationId: 'op-rpc-conversation-fork',
      command: 'plan_fork',
      params: {
        conversationId: created.id,
        branchId: created.activeBranchId,
        messageId,
        workspace: false,
      },
    })}\n`
    const plan = resultFor<{ digest: string; destinationBranchId: string }>(
      responses,
      'conversation-plan',
    )
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-execute',
      operationId: 'op-rpc-conversation-fork',
      command: 'execute_fork',
      params: {
        planDigest: plan.digest,
        conversationId: created.id,
        branchId: created.activeBranchId,
        messageId,
        workspace: false,
      },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-export',
      operationId: 'op-rpc-conversation-export',
      command: 'export',
      params: { target: created.id, format: 'markdown' },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-export-json',
      operationId: 'op-rpc-conversation-export-json',
      command: 'export',
      params: { target: created.id, format: 'json' },
    })}\n`
    const canonicalExport = resultFor<{ readonly content?: string }>(
      responses,
      'conversation-export-json',
    )
    assert(canonicalExport.content)
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-import',
      operationId: 'op-rpc-conversation-import',
      command: 'import_conversation',
      params: { content: canonicalExport.content, title: 'Imported over JSONL' },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-delete',
      operationId: 'op-rpc-conversation-delete',
      command: 'delete_conversation',
      params: { conversationId: created.id },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'conversation-stop',
      operationId: 'op-rpc-conversation-stop',
      command: 'shutdown',
    })}\n`
  }

  const code = await runRpc(controllerFor(app), input(), {
    write: (chunk) => {
      responses.push(JSON.parse(chunk) as BraidResponse)
      return true
    },
  })
  const list = resultFor<readonly { readonly id: string }[]>(responses, 'conversation-list')
  const created = resultFor<{ readonly id: string }>(responses, 'conversation-create')
  const draft = resultFor<{ readonly text: string }>(responses, 'conversation-draft')
  const replayedDraft = resultFor<{ readonly text: string }>(responses, 'conversation-draft-replay')
  const plan = resultFor<{ readonly destinationBranchId: string }>(responses, 'conversation-plan')
  const fork = resultFor<{ readonly id: string }>(responses, 'conversation-execute')
  const exported = resultFor<{ readonly content?: string; readonly format: string }>(
    responses,
    'conversation-export',
  )
  const imported = resultFor<{ readonly conversationId: string; readonly replayed: boolean }>(
    responses,
    'conversation-import',
  )
  const deleted = resultFor<{ readonly deletedAt?: string }>(responses, 'conversation-delete')

  assert.equal(code, 0)
  assert.equal(list.length, 1)
  assert.equal(draft.text, 'durable JSONL draft')
  assert.deepEqual(replayedDraft, draft)
  assert.equal(fork.id, plan.destinationBranchId)
  assert.equal(exported.format, 'markdown')
  assert.match(exported.content ?? '', /Renamed over JSONL/u)
  assert.equal(imported.replayed, false)
  assert.notEqual(imported.conversationId, created.id)
  assert.equal(typeof deleted.deletedAt, 'string')
  assert.equal(
    responses.some((response) => response.type === 'error'),
    false,
  )
})

test('JSONL run configuration is replay safe, visible, and reaches Runtime', async () => {
  let streamedProfile: unknown
  const execution: ExecutionPort = {
    admit: () => ({}),
    async *streamTurn(input): AsyncIterable<RuntimeStreamEvent> {
      streamedProfile = structuredClone(input.profile)
      yield {
        type: 'final',
        status: 'completed',
        reason: 'JSONL run configuration completed',
        text: 'configured JSONL run completed',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'rpc-run-configuration', intent: 'JSONL run configuration' },
        timestamp: '2026-08-03T00:00:00.000Z',
      }
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  const responses: BraidResponse[] = []
  async function* input(): AsyncGenerator<string> {
    yield `${JSON.stringify({
      version: 1,
      requestId: 'run-configuration-init',
      command: 'initialize',
      params: { workspace: '/workspace' },
    })}\n`
    const override = {
      version: 1,
      operationId: 'op-rpc-run-configuration',
      command: 'set_run_override',
      params: {
        runner: 'codex',
        model: 'openai/gpt-5.6',
        effort: 'xhigh',
        mode: 'interactive',
      },
    }
    yield `${JSON.stringify({ ...override, requestId: 'run-configuration-set' })}\n`
    yield `${JSON.stringify({ ...override, requestId: 'run-configuration-replay' })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'run-configuration-send',
      operationId: 'op-rpc-run-configuration-send',
      command: 'send',
      params: { text: 'use the JSONL branch configuration' },
    })}\n`
    await app.waitForIdle()
    yield `${JSON.stringify({
      version: 1,
      requestId: 'run-configuration-state',
      command: 'get_state',
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'run-configuration-clear',
      operationId: 'op-rpc-run-configuration-clear',
      command: 'set_run_override',
      params: { clear: true },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'run-configuration-cleared-state',
      command: 'get_state',
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'run-configuration-stop',
      operationId: 'op-rpc-run-configuration-stop',
      command: 'shutdown',
    })}\n`
  }

  const code = await runRpc(controllerFor(app), input(), {
    write: responseWriter(responses),
  })
  const configured = resultFor<{ readonly overrides: Readonly<Record<string, string>> }>(
    responses,
    'run-configuration-set',
  )
  const replayed = resultFor<{ readonly overrides: Readonly<Record<string, string>> }>(
    responses,
    'run-configuration-replay',
  )
  const cleared = resultFor<{ readonly overrides: Readonly<Record<string, string>> }>(
    responses,
    'run-configuration-clear',
  )
  const configuredState = responses.find(
    (response) => response.type === 'state' && response.requestId === 'run-configuration-state',
  )
  const clearedState = responses.find(
    (response) =>
      response.type === 'state' && response.requestId === 'run-configuration-cleared-state',
  )

  assert.equal(code, 0)
  assert.deepEqual(configured.overrides, {
    runner: 'codex',
    model: 'openai/gpt-5.6',
    effort: 'xhigh',
    mode: 'interactive',
  })
  assert.deepEqual(replayed, configured)
  assert.deepEqual(cleared.overrides, {})
  assert.deepEqual(streamedProfile, {
    ...DETERMINISTIC_PROFILE,
    harness: 'codex',
    model: {
      ...DETERMINISTIC_PROFILE.model,
      default: 'openai/gpt-5.6',
      reasoningEffort: 'xhigh',
    },
  })
  assert(configuredState?.type === 'state' && configuredState.projection === 'full')
  assert.deepEqual(configuredState.state.runConfiguration, {
    profileName: DETERMINISTIC_PROFILE.name,
    runner: 'codex',
    model: 'openai/gpt-5.6',
    effort: 'xhigh',
    mode: 'interactive',
    overrides: {
      runner: 'codex',
      model: 'openai/gpt-5.6',
      effort: 'xhigh',
      mode: 'interactive',
    },
  })
  assert(clearedState?.type === 'state' && clearedState.projection === 'full')
  assert.equal(clearedState.state.runConfiguration.runner, DETERMINISTIC_PROFILE.harness)
  assert.equal(clearedState.state.runConfiguration.model, DETERMINISTIC_PROFILE.model?.default)
  assert.deepEqual(clearedState.state.runConfiguration.overrides, {})
  assert.equal(
    app
      .events()
      .filter(
        (entry) =>
          entry.event.kind === 'branch.updated' &&
          entry.event.operation.id === 'op-rpc-run-configuration',
      ).length,
    1,
  )
  assert.equal(
    responses.some((response) => response.type === 'error'),
    false,
  )
})

test('JSONL accepts a valid inline conversation import larger than one MiB', async () => {
  const source = createBraidApplication({ fixture: 'deterministic' })
  source.initialize('/workspace')
  await source.whenDurable()
  const exported = await source.conversations.exports.export({
    operationId: 'op-rpc-large-import-export',
    format: 'json',
  })
  assert(exported.content)
  const document = JSON.parse(exported.content) as {
    content: { conversation: { title: string }; [key: string]: unknown }
    contentDigest: string
    [key: string]: unknown
  }
  document.content.conversation.title = 'x'.repeat(1_100_000)
  document.contentDigest = canonicalDigest(document.content)
  const request = {
    version: 1,
    requestId: 'req-large-import',
    operationId: 'op-rpc-large-import',
    command: 'import_conversation',
    params: { content: JSON.stringify(document) },
  }
  assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') > 1024 * 1024)

  const app = createBraidApplication({ fixture: 'deterministic' })
  const responses: BraidResponse[] = []
  const code = await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-large-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      request,
      {
        version: 1,
        requestId: 'req-large-stop',
        operationId: 'op-rpc-large-stop',
        command: 'shutdown',
      },
    ]),
    {
      write: (chunk) => {
        responses.push(JSON.parse(chunk) as BraidResponse)
        return true
      },
    },
  )
  const imported = resultFor<{ readonly conversationId: string }>(responses, 'req-large-import')

  assert.equal(code, 0)
  assert.equal(
    app.state().conversations.some((conversation) => conversation.id === imported.conversationId),
    true,
  )
})

test('JSONL cancel interrupts an active send and reports the terminal state', async () => {
  const requestedReason = 'operator requested cancellation'
  let providerReason: string | undefined
  let releaseStream: (() => void) | undefined
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input) {
      yield { type: 'text_delta', text: 'waiting for cancellation' }
      await new Promise<void>((resolve) => {
        releaseStream = resolve
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    cancelRun: async (input) => {
      providerReason = input.reason
      releaseStream?.()
      return { operationId: input.operationId, outcome: 'accepted' }
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  let output = ''
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace', subscribe: true },
      },
      {
        version: 1,
        requestId: 'req-send',
        operationId: 'op-cancel-send',
        command: 'send',
        params: { text: 'cancel this active turn' },
      },
      {
        version: 1,
        requestId: 'req-cancel',
        operationId: 'op-cancel-active',
        command: 'cancel_run',
        params: { runId: 'run-000001', reason: requestedReason },
      },
      {
        version: 1,
        requestId: 'req-stop',
        operationId: 'op-stop-cancel',
        command: 'shutdown',
      },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const responses = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
  assert.ok(
    responses.some(
      (response) => response.type === 'event' && response.event.kind === 'run.cancel.requested',
    ),
  )
  const controlEvents = app
    .events()
    .filter(
      (entry) =>
        entry.event.kind === 'run.control.requested' || entry.event.kind === 'run.cancel.requested',
    )
  assert.deepEqual(
    controlEvents.map((entry) =>
      entry.event.kind === 'run.control.requested' || entry.event.kind === 'run.cancel.requested'
        ? entry.event.reason
        : undefined,
    ),
    [requestedReason, requestedReason],
  )
  assert.equal(providerReason, requestedReason)
  const cancelState = responses.find(
    (response) => response.type === 'state' && response.requestId === 'req-cancel',
  )
  assert.equal(cancelState?.type, 'state')
  if (cancelState?.type !== 'state') assert.fail('missing cancellation state')
  if (cancelState.projection !== 'full') assert.fail('expected full cancellation state')
  assert.equal(cancelState.state.runs[0]?.status, 'aborted')
})

test('RPC and plain shutdown exit at the drain deadline for a never-ending iterator', async () => {
  for (const mode of ['rpc', 'plain'] as const) {
    const streamStarted = deferred()
    let providerCancellationCalls = 0
    const execution: ExecutionPort = {
      capabilities: () => DEFAULT_RUN_CAPABILITIES,
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        streamStarted.resolve()
        await new Promise<void>(() => {})
      },
      async cancelRun(input) {
        providerCancellationCalls += 1
        return { operationId: input.operationId, outcome: 'accepted' as const }
      },
    }
    const app = createBraidApplication({
      fixture: 'deterministic',
      execution,
      cancelTimeoutMs: 25,
    })
    const writes: string[] = []
    const output = {
      write: (chunk: string): boolean => {
        writes.push(chunk)
        return true
      },
    }
    const startedAt = Date.now()
    let code: number
    if (mode === 'rpc') {
      async function* input(): AsyncGenerator<string> {
        yield `${[
          {
            version: 1,
            requestId: 'req-never-init',
            command: 'initialize',
            params: { workspace: '/workspace' },
          },
          {
            version: 1,
            requestId: 'req-never-send',
            operationId: 'op-never-send',
            command: 'send',
            params: { text: 'never ending provider iterator' },
          },
        ]
          .map((request) => JSON.stringify(request))
          .join('\n')}\n`
        await streamStarted.promise
        yield `${JSON.stringify({
          version: 1,
          requestId: 'req-never-shutdown',
          operationId: 'op-never-shutdown',
          command: 'shutdown',
          params: { mode: 'cancel' },
        })}\n`
      }
      code = await runRpc(controllerFor(app), input(), output)
    } else {
      async function* input(): AsyncGenerator<string> {
        yield 'never ending provider iterator\n'
        await streamStarted.promise
        yield '/quit\n'
      }
      code = await runPlain(controllerFor(app), '/workspace', input(), output)
    }
    const writesAtExit = writes.length
    const elapsedMs = Date.now() - startedAt
    await new Promise<void>((resolve) => setTimeout(resolve, 60))

    assert.equal(code, 0)
    assert.equal(providerCancellationCalls, 1)
    assert.ok(elapsedMs < 1_000, `${mode} shutdown exceeded bounded drain: ${elapsedMs}ms`)
    assert.equal(writes.length, writesAtExit)
    assert.equal(app.state().runs[0]?.status, 'aborted')
    await app.close()
  }
})

test('JSONL cancellation preserves a provider rejection without marking the run cancelled', async () => {
  let releaseStream: (() => void) | undefined
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn() {
      yield { type: 'text_delta', text: 'provider rejection test' }
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
      yield {
        type: 'final',
        status: 'completed',
        reason: 'provider continued after rejecting cancellation',
        text: 'provider continued',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-rejected-cancel', intent: 'provider rejection test' },
        timestamp: '2026-08-01T00:00:00.000Z',
      } satisfies RuntimeStreamEvent
    },
    cancelRun: async (input) => {
      releaseStream?.()
      return {
        operationId: input.operationId,
        outcome: 'rejected',
        detail: 'Provider refused cancellation',
      }
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  const responses: BraidResponse[] = []
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-rejected-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-rejected-send',
        operationId: 'op-rejected-send',
        command: 'send',
        params: { text: 'reject cancellation' },
      },
      {
        version: 1,
        requestId: 'req-rejected-cancel',
        operationId: 'op-rejected-cancel',
        command: 'cancel_run',
        params: { runId: 'run-000001' },
      },
      {
        version: 1,
        requestId: 'req-rejected-stop',
        operationId: 'op-rejected-stop',
        command: 'shutdown',
      },
    ]),
    { write: responseWriter(responses) },
  )
  const acknowledgement = responses.find(
    (response) => response.type === 'ack' && response.requestId === 'req-rejected-cancel',
  )
  assert.equal(acknowledgement?.type, 'ack')
  if (acknowledgement?.type !== 'ack') assert.fail('missing rejection acknowledgement')
  assert.equal(acknowledgement.outcome, 'rejected')
  const state = responses.find(
    (response) => response.type === 'state' && response.requestId === 'req-rejected-cancel',
  )
  assert.equal(state?.type, 'state')
  if (state?.type !== 'state' || state.projection !== 'full') assert.fail('missing rejection state')
  assert.equal(state.state.runs[0]?.status, 'completed')
})

test('JSONL cancellation reports the deadline then applies a late provider acknowledgement', async () => {
  let releaseStream: (() => void) | undefined
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn() {
      yield { type: 'text_delta', text: 'provider timeout test' }
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
    },
    cancelRun: async (input) => {
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          input.signal?.removeEventListener('abort', onAbort)
          releaseStream?.()
          resolve()
        }
        if (input.signal?.aborted) onAbort()
        else input.signal?.addEventListener('abort', onAbort, { once: true })
      })
      return { operationId: input.operationId, outcome: 'accepted' }
    },
  }
  const app = createBraidApplication({
    fixture: 'deterministic',
    execution,
    cancelTimeoutMs: 10,
  })
  const responses: BraidResponse[] = []
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-timeout-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-timeout-send',
        operationId: 'op-timeout-send',
        command: 'send',
        params: { text: 'timeout cancellation' },
      },
      {
        version: 1,
        requestId: 'req-timeout-cancel',
        operationId: 'op-timeout-cancel',
        command: 'cancel_run',
        params: { runId: 'run-000001' },
      },
      {
        version: 1,
        requestId: 'req-timeout-stop',
        operationId: 'op-timeout-stop',
        command: 'shutdown',
      },
    ]),
    { write: responseWriter(responses) },
  )
  const acknowledgement = responses.find(
    (response) => response.type === 'ack' && response.requestId === 'req-timeout-cancel',
  )
  assert.equal(acknowledgement?.type, 'ack')
  if (acknowledgement?.type !== 'ack') assert.fail('missing timeout acknowledgement')
  assert.equal(acknowledgement.outcome, 'unknown')
  const state = responses.find(
    (response) => response.type === 'state' && response.requestId === 'req-timeout-cancel',
  )
  assert.equal(state?.type, 'state')
  if (state?.type !== 'state' || state.projection !== 'full') assert.fail('missing timeout state')
  assert.equal(state.state.runs[0]?.status, 'aborted')
})

test('JSONL cancellation stays unavailable when the runtime does not advertise provider support', async () => {
  const execution: ExecutionPort = {
    capabilities: () => UNKNOWN_RUN_CAPABILITIES,
    async *streamTurn(input) {
      yield { type: 'text_delta', text: 'unsupported cancellation test' }
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  const responses: BraidResponse[] = []
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-unsupported-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-unsupported-send',
        operationId: 'op-unsupported-send',
        command: 'send',
        params: { text: 'unsupported cancellation' },
      },
      {
        version: 1,
        requestId: 'req-unsupported-cancel',
        operationId: 'op-unsupported-cancel',
        command: 'cancel_run',
        params: { runId: 'run-000001' },
      },
      {
        version: 1,
        requestId: 'req-unsupported-stop',
        operationId: 'op-unsupported-stop',
        command: 'shutdown',
        params: { mode: 'cancel' },
      },
    ]),
    { write: responseWriter(responses) },
  )
  const response = responses.find(
    (candidate) => candidate.type === 'error' && candidate.requestId === 'req-unsupported-cancel',
  )
  assert.equal(response?.type, 'error')
  if (response?.type !== 'error') assert.fail('missing unsupported cancellation response')
  assert.equal(response.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(app.state().runs[0]?.status, 'unknown')
})

test('JSONL malformed UTF-8 cancels a delayed run before the outer close', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 250 })
  async function* input(): AsyncGenerator<string | Uint8Array> {
    yield `${[
      {
        version: 1,
        requestId: 'req-init-malformed',
        command: 'initialize',
        params: { workspace: '/workspace', subscribe: true },
      },
      {
        version: 1,
        requestId: 'req-send-malformed',
        operationId: 'op-send-malformed',
        command: 'send',
        params: { text: 'delayed run before malformed input' },
      },
    ]
      .map((request) => JSON.stringify(request))
      .join('\n')}\n`
    yield new Uint8Array([0xc3, 0x28])
  }

  await assert.rejects(
    runRpc(controllerFor(app), input(), { write: () => true }),
    /malformed UTF-8/iu,
  )
  assert.equal(
    app.events().filter((entry) => entry.event.kind === 'application.shutdown.requested').length,
    1,
  )
  await app.close()
  const eventsAfterClose = app.events().length
  assert.equal(app.state().runs[0]?.status, 'aborted')

  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  assert.equal(app.events().length, eventsAfterClose)
})

test('plain oversized input cancels a delayed run before the outer close', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 250 })
  async function* input(): AsyncGenerator<string> {
    yield 'delayed plain run\n'
    yield 'x'.repeat(MAX_RPC_LINE_BYTES + 1)
  }

  await assert.rejects(
    runPlain(controllerFor(app), '/workspace', input(), { write: () => true }),
    /LINE_TOO_LARGE/iu,
  )
  assert.equal(
    app.events().filter((entry) => entry.event.kind === 'application.shutdown.requested').length,
    1,
  )
  await app.close()
  const eventsAfterClose = app.events().length
  assert.equal(app.state().runs[0]?.status, 'aborted')

  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  assert.equal(app.events().length, eventsAfterClose)
})

test('plain output failure cancels the delayed run before the outer close', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 250 })
  const outputFailed = deferred()
  let writes = 0
  const output = {
    write: (_chunk: string): boolean => {
      writes += 1
      if (writes === 3) {
        outputFailed.resolve()
        throw new Error('OUTPUT_FAILURE')
      }
      return true
    },
  }
  async function* input(): AsyncGenerator<string> {
    yield 'delayed output run\n'
    await outputFailed.promise
    yield '\n'
  }

  await assert.rejects(
    runPlain(controllerFor(app), '/workspace', input(), output),
    (error: unknown) => error instanceof Error && error.message === 'OUTPUT_FAILURE',
  )
  assert.equal(
    app.events().filter((entry) => entry.event.kind === 'application.shutdown.requested').length,
    1,
  )
  await app.close()
  const eventsAfterClose = app.events().length
  assert.equal(app.state().runs[0]?.status, 'aborted')

  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  assert.equal(app.events().length, eventsAfterClose)
})

test('plain mode generates redaction-stable operation identifiers', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  async function* input(): AsyncGenerator<string> {
    yield 'verify generated operation identity\n'
  }

  await runPlain(controllerFor(app), '/workspace', input(), { write: () => true })

  const operationId = app.state().runs[0]?.operationId
  assert(operationId)
  assert.match(
    operationId,
    /^op-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  )
  assert.equal(redactSensitiveText(operationId), operationId)
})

test('JSONL requires initialize and stable operation identity', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-send',
        operationId: 'op-rpc',
        command: 'send',
        params: { text: 'too early' },
      },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const response = JSON.parse(output) as BraidResponse
  assert.equal(response.type, 'error')
  if (response.type !== 'error') assert.fail('missing error')
  assert.equal(response.code, 'INITIALIZE_REQUIRED')
})

test('JSONL replays identical request IDs and rejects changed bodies', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      { version: 1, requestId: 'req-state', command: 'get_state' },
      { version: 1, requestId: 'req-state', command: 'get_state' },
      {
        version: 1,
        requestId: 'req-state',
        operationId: 'op-state-shutdown',
        command: 'shutdown',
      },
      {
        version: 1,
        requestId: 'req-stop',
        operationId: 'op-stop-2',
        command: 'shutdown',
      },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const responses = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
  const replayed = responses.filter(
    (response) => response.type === 'state' && response.requestId === 'req-state',
  )
  const conflict = responses.find(
    (response) => response.type === 'error' && response.requestId === 'req-state',
  )

  assert.equal(replayed.length, 2)
  assert.deepEqual(replayed[1], replayed[0])
  assert.equal(conflict?.type, 'error')
  if (conflict?.type !== 'error') assert.fail('missing request ID conflict')
  assert.equal(conflict.code, 'REQUEST_ID_CONFLICT')
})

test('JSONL summary projection omits full transcript and profile data', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-summary',
        command: 'get_state',
        params: { projection: 'summary' },
      },
      {
        version: 1,
        requestId: 'req-stop',
        operationId: 'op-stop-3',
        command: 'shutdown',
      },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const summary = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
    .find((response) => response.type === 'state' && response.requestId === 'req-summary')
  assert.equal(summary?.type, 'state')
  if (summary?.type !== 'state') assert.fail('missing summary state')
  assert.equal(summary.projection, 'summary')
  if (summary.projection !== 'summary') assert.fail('wrong state projection')
  assert.equal(summary.state.messageCount, 0)
  assert.equal('messages' in summary.state, false)
  assert.equal('profile' in summary.state, false)
  assert.equal('view' in summary, false)
})

test('headless state redacts generic secret keys, secret contexts, and credential URLs', () => {
  const app = createBraidApplication({
    fixture: 'deterministic',
    profile: {
      ...DETERMINISTIC_PROFILE,
      metadata: {
        secret: 'CANARY-SECRET',
        secretAnswer: 'CANARY-ANSWER',
        token: 'CANARY-TOKEN',
        callback: 'https://user:CANARY@example.com/?token=CANARY',
        challenge: { secret: true, answer: 'CANARY-CONTEXT' },
      },
    },
  })
  const serialized = JSON.stringify(controllerFor(app).state())
  assert.equal(serialized.includes('CANARY'), false)
  assert.match(serialized, /\[redacted\]/u)
})

test('JSONL rejects wrong optional types and unknown fields', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-bad-init',
        command: 'initialize',
        params: { workspace: '/workspace', subscribe: 'yes' },
      },
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-bad-branch',
        operationId: 'op-bad-branch',
        command: 'send',
        params: { text: 'wrong branch type', branchId: 42 },
      },
      {
        version: 1,
        requestId: 'req-extra',
        command: 'get_state',
        params: { extra: true },
      },
      {
        version: 1,
        requestId: 'req-stop',
        operationId: 'op-stop-4',
        command: 'shutdown',
      },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const errors = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
    .filter((response) => response.type === 'error')

  assert.deepEqual(
    errors.map((error) => error.code),
    ['INVALID_PARAMS', 'INVALID_PARAMS', 'INVALID_PARAMS'],
  )
  assert.equal(app.state().messages.length, 0)
})

test('JSONL operation replay returns current state after later sends', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-a',
        operationId: 'op-a',
        command: 'send',
        params: { text: 'first' },
      },
      {
        version: 1,
        requestId: 'req-b',
        operationId: 'op-b',
        command: 'send',
        params: { text: 'second' },
      },
      {
        version: 1,
        requestId: 'req-a-replay',
        operationId: 'op-a',
        command: 'send',
        params: { text: 'first' },
      },
      {
        version: 1,
        requestId: 'req-stop',
        operationId: 'op-stop-5',
        command: 'shutdown',
      },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const replayState = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
    .filter((response) => response.type === 'state' && response.requestId === 'req-a-replay')
    .at(-1)
  const stateAfterSecondSend = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
    .filter((response) => response.type === 'state' && response.requestId === 'req-b')
    .at(-1)

  assert.equal(replayState?.type, 'state')
  if (replayState?.type !== 'state') assert.fail('missing replay state')
  assert.equal(replayState.projection, 'full')
  if (replayState.projection !== 'full') assert.fail('expected full replay state')
  assert.equal(stateAfterSecondSend?.type, 'state')
  if (stateAfterSecondSend?.type !== 'state') assert.fail('missing second send state')
  assert.equal(replayState.state.messages.length, 4)
  assert.equal(replayState.state.revision, stateAfterSecondSend.state.revision)
  assert.equal(app.state().revision, replayState.state.revision + 1)
  assert.equal(app.events().at(-1)?.event.kind, 'application.shutdown.requested')
})

test('JSONL bounds direct-response replay while operation replay stays safe', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  let output = ''
  const filler = Array.from({ length: RPC_REPLAY_MAX_ENTRIES }, (_, index) => ({
    version: 1,
    requestId: `req-filler-${index}`,
    command: 'get_state',
  }))
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-send-old',
        operationId: 'op-once',
        command: 'send',
        params: { text: 'execute once' },
      },
      ...filler,
      {
        version: 1,
        requestId: 'req-send-retry',
        operationId: 'op-once',
        command: 'send',
        params: { text: 'execute once' },
      },
      {
        version: 1,
        requestId: 'req-send-retry',
        operationId: 'op-once',
        command: 'send',
        params: { text: 'execute once' },
      },
      {
        version: 1,
        requestId: 'req-stop',
        operationId: 'op-stop-6',
        command: 'shutdown',
      },
    ]),
    {
      write: (chunk) => {
        output += chunk
        return true
      },
    },
  )
  const responses = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BraidResponse)
  const replayAcks = responses.filter(
    (response) => response.type === 'ack' && response.requestId === 'req-send-retry',
  )

  assert.equal(app.state().runs.length, 1)
  assert.equal(app.state().messages.length, 2)
  assert.equal(replayAcks.length, 2)
  assert.equal(replayAcks[0]?.type, 'ack')
  if (replayAcks[0]?.type !== 'ack') assert.fail('missing operation replay acknowledgement')
  assert.equal(replayAcks[0].replayed, true)
  assert.deepEqual(replayAcks[1], replayAcks[0])
})

test('JSONL evicts oldest responses when the replay payload budget is full', async () => {
  const app = createBraidApplication({
    fixture: 'deterministic',
    profile: {
      ...DETERMINISTIC_PROFILE,
      description: 'x'.repeat(3 * 1024 * 1024),
    },
  })
  const states: Array<{ readonly requestId: string; readonly revision: number }> = []
  async function* input(): AsyncGenerator<string> {
    yield `${JSON.stringify({
      version: 1,
      requestId: 'req-init',
      command: 'initialize',
      params: { workspace: '/workspace' },
    })}\n`
    for (const requestId of ['req-a', 'req-b', 'req-c']) {
      yield `${JSON.stringify({ version: 1, requestId, command: 'get_state' })}\n`
    }
    await app.send({ operationId: 'op-after-cache', text: 'advance state' }).completion
    yield `${JSON.stringify({ version: 1, requestId: 'req-c', command: 'get_state' })}\n`
    yield `${JSON.stringify({ version: 1, requestId: 'req-a', command: 'get_state' })}\n`
    yield `${JSON.stringify({ version: 1, requestId: 'req-stop', operationId: 'op-stop-7', command: 'shutdown' })}\n`
  }

  await runRpc(controllerFor(app), input(), {
    write: (chunk) => {
      const response = JSON.parse(chunk) as BraidResponse
      if (
        response.type === 'state' &&
        (response.requestId === 'req-a' || response.requestId === 'req-c')
      ) {
        states.push({ requestId: response.requestId, revision: response.revision })
      }
      return true
    },
  })
  const a = states.filter((state) => state.requestId === 'req-a')
  const c = states.filter((state) => state.requestId === 'req-c')

  assert.equal(a.length, 2)
  assert.equal(c.length, 2)
  assert.ok((a[1]?.revision ?? 0) > (a[0]?.revision ?? 0))
  assert.equal(c[1]?.revision, c[0]?.revision)
})

test('JSONL rejects replay when one direct response exceeds the payload budget', async () => {
  const app = createBraidApplication({
    fixture: 'deterministic',
    profile: {
      ...DETERMINISTIC_PROFILE,
      description: 'x'.repeat(RPC_REPLAY_MAX_BYTES),
    },
  })
  const responses: Array<{
    readonly type: BraidResponse['type']
    readonly code?: string
    readonly bytes: number
  }> = []
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'req-init',
        command: 'initialize',
        params: { workspace: '/other' },
      },
      {
        version: 1,
        requestId: 'req-stop',
        operationId: 'op-stop-8',
        command: 'shutdown',
      },
    ]),
    {
      write: (chunk) => {
        const response = JSON.parse(chunk) as BraidResponse
        responses.push({
          type: response.type,
          ...(response.type === 'error' ? { code: response.code } : {}),
          bytes: Buffer.byteLength(chunk),
        })
        return true
      },
    },
  )
  const oversized = responses.find(
    (response) => response.type === 'state' && response.bytes > RPC_REPLAY_MAX_BYTES,
  )
  const errors = responses.filter((response) => response.type === 'error')

  assert.ok(oversized)
  assert.deepEqual(
    errors.map((error) => error.code),
    ['REQUEST_REPLAY_UNAVAILABLE', 'REQUEST_ID_CONFLICT'],
  )
})

test('JSONL semantic queries return canonical graph, activity, and details results', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const sent = app.send({ operationId: 'op-semantic-query', text: 'query me' })
  await sent.completion
  const state = app.state()
  const responses: BraidResponse[] = []
  await runRpc(
    controllerFor(app),
    requestInput([
      {
        version: 1,
        requestId: 'semantic-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'semantic-graph',
        command: 'get_graph',
        params: { conversationId: state.conversationId, branchId: state.branchId },
      },
      {
        version: 1,
        requestId: 'semantic-activity',
        command: 'get_activity',
        params: { runId: sent.runId },
      },
      {
        version: 1,
        requestId: 'semantic-details',
        command: 'get_details',
        params: { entityType: 'run', entityId: sent.runId },
      },
      {
        version: 1,
        requestId: 'semantic-unknown',
        command: 'get_details',
        params: { entityType: 'run', entityId: 'run-does-not-exist' },
      },
      {
        version: 1,
        requestId: 'semantic-stop',
        operationId: 'op-semantic-stop',
        command: 'shutdown',
      },
    ]),
    {
      write: (chunk) => {
        responses.push(JSON.parse(chunk) as BraidResponse)
        return true
      },
    },
  )

  const graph = resultFor<GraphQueryResult>(responses, 'semantic-graph')
  const activity = resultFor<ActivityQueryResult>(responses, 'semantic-activity')
  const details = resultFor<DetailsQueryResult>(responses, 'semantic-details')
  assert.equal(graph.conversationId, state.conversationId)
  assert.equal(graph.branchId, state.branchId)
  assert.ok(graph.nodes.some((node) => node.type === 'conversation'))
  assert.ok(graph.nodes.some((node) => node.type === 'turn'))
  assert.ok(graph.nodes.some((node) => node.type === 'run' && node.id === sent.runId))
  assert.ok(graph.edges.some((edge) => edge.kind === 'continued'))
  assert.ok(graph.edges.some((edge) => edge.kind === 'attached'))
  assert.equal(activity.runId, sent.runId)
  assert.equal(activity.activity[0]?.runId, sent.runId)
  assert.equal(details.entityType, 'run')
  assert.equal(details.entityId, sent.runId)
  assert.ok(details.fields.some((field) => field.label === 'status'))
  assert.equal(
    responses.filter(
      (response) =>
        response.type === 'state' &&
        ['semantic-graph', 'semantic-activity', 'semantic-details', 'semantic-unknown'].includes(
          response.requestId,
        ),
    ).length,
    0,
  )
  const unknown = responses.find(
    (response) => response.type === 'error' && response.requestId === 'semantic-unknown',
  )
  assert.equal(unknown?.type, 'error')
  if (unknown?.type === 'error') assert.equal(unknown.code, 'UNKNOWN_ENTITY')
})

test('semantic queries enforce scope, redact details, preserve ordering, and survive replay', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const firstConversation = app.state().conversations[0]
  assert.ok(firstConversation)
  const sent = app.send({
    operationId: 'op-semantic-scoped-send',
    conversationId: firstConversation.id,
    branchId: firstConversation.activeBranchId,
    text: 'scoped turn',
  })
  await sent.completion
  const secondConversation = await app.conversations.lifecycle.create({
    operationId: 'op-semantic-second-conversation',
    title: 'Second conversation',
  })
  const state = app.state()
  const scopedGraph = queryGraph(state, { branchId: firstConversation.activeBranchId })
  assert.ok(scopedGraph.nodes.length > 0)
  assert.equal(
    scopedGraph.nodes.some((node) => node.id === secondConversation.id),
    false,
  )
  assert.throws(
    () => queryGraph(state, { conversationId: 'conversation-does-not-exist' }),
    (error: unknown) =>
      error instanceof SemanticQueryError && error.code === 'UNKNOWN_CONVERSATION',
  )
  assert.throws(
    () =>
      queryGraph(state, {
        conversationId: firstConversation.id,
        branchId: secondConversation.activeBranchId,
      }),
    (error: unknown) =>
      error instanceof SemanticQueryError && error.code === 'BRANCH_SCOPE_CONFLICT',
  )
  assert.throws(
    () => queryActivity(state, { runId: 'run-does-not-exist' }),
    (error: unknown) => error instanceof SemanticQueryError && error.code === 'UNKNOWN_RUN',
  )
  assert.throws(
    () => queryDetails(state, { entityType: 'not-a-node', entityId: 'entity-1' }),
    (error: unknown) => error instanceof SemanticQueryError && error.code === 'UNKNOWN_ENTITY_TYPE',
  )
  assert.throws(
    () => queryDetails(state, { entityType: 'run', entityId: 'run-does-not-exist' }),
    (error: unknown) => error instanceof SemanticQueryError && error.code === 'UNKNOWN_ENTITY',
  )

  assert.deepEqual(scopedGraph, queryGraph(state, { branchId: firstConversation.activeBranchId }))
  const runOnly = queryGraph(state, { query: 'type:run' })
  for (const runNode of runOnly.nodes) {
    const unfiltered = queryGraph(state).nodes.find(
      (node) => node.type === runNode.type && node.id === runNode.id,
    )
    assert.equal(runNode.depth, unfiltered?.depth)
  }
  const reorderedState = {
    ...state,
    conversations: [...state.conversations].reverse(),
    branches: [...state.branches].reverse(),
    turns: [...state.turns].reverse(),
    runs: [...state.runs].reverse(),
    analyses: [...state.analyses].reverse(),
    environments: [...state.environments].reverse(),
    checkpoints: [...state.checkpoints].reverse(),
    supervisors: [...state.supervisors].reverse(),
    workers: [...state.workers].reverse(),
    bindings: [...state.bindings].reverse(),
    graphNodes: [...state.graphNodes].reverse(),
    graphEdges: [...state.graphEdges].reverse(),
  }
  assert.deepEqual(queryGraph(state), queryGraph(reorderedState))
  assert.deepEqual(queryActivity(state), queryActivity(reorderedState))
  const secretState = {
    ...state,
    runs: state.runs.map((run) =>
      run.id === sent.runId ? { ...run, error: 'api_key=super-secret-value' } : run,
    ),
  }
  const details = queryDetails(secretState, { entityType: 'run', entityId: sent.runId })
  assert.equal(JSON.stringify(details).includes('super-secret-value'), false)
  assert.equal(JSON.stringify(details).includes('api_key'), false)

  const journal = new MemoryJournal(new FixedClock())
  const first = createBraidApplication({ fixture: 'deterministic', journal })
  first.initialize('/workspace')
  const restartRun = first.send({ operationId: 'op-semantic-restart', text: 'restart query' })
  await restartRun.completion
  const restarted = createBraidApplication({ fixture: 'deterministic', journal })
  assert.deepEqual(queryGraph(first.state()), queryGraph(restarted.state()))
  assert.deepEqual(queryActivity(first.state()), queryActivity(restarted.state()))
  assert.deepEqual(
    queryDetails(first.state(), { entityType: 'run', entityId: restartRun.runId }),
    queryDetails(restarted.state(), { entityType: 'run', entityId: restartRun.runId }),
  )
})

test('semantic and protocol ordering is independent of the host locale', () => {
  assert.equal(compareSemanticText('z', 'ä') < 0, true)
  assert.equal(compareSemanticText('ä', 'z') > 0, true)
  assert.equal(compareSemanticText('same', 'same'), 0)
})
