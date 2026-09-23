import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { createBraidApplication } from '../src/app/composition.js'
import { InteractionController } from '../src/controllers/interaction-controller.js'
import { FixedClock } from '../src/ports/clock.js'
import { SequenceIds } from '../src/ports/ids.js'
import { interactionKey } from '../src/domain/interaction-state.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'
import { parseArgs } from '../src/bin/args.js'
import { DeterministicInteractionRuntime } from '../src/testing/deterministic-interaction-runtime.js'

async function* input(lines: readonly object[]): AsyncGenerator<string> {
  yield `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

function responsesOf(output: string): BraidResponse[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BraidResponse)
}

test('W12 the real argument parser exposes plain mode', () => {
  assert.equal(parseArgs(['--plain', '--fixture', 'deterministic'], '/workspace').mode, 'plain')
})

test('W13 all automation commands use the JSONL application path', async () => {
  const runtime = new DeterministicInteractionRuntime()
  const app = createBraidApplication({
    fixture: 'deterministic',
    interactionRuntime: runtime,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  const received = app.receiveInteraction({
    runId: 'run-jsonl-automation',
    request: {
      id: 'jsonl-automation',
      kind: 'question',
      title: 'Automation',
      answerSpec: {
        fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
      },
    },
  })
  const ruleKey = interactionKey('run-jsonl-automation', 'jsonl-automation')
  assert.equal(received.key, ruleKey)
  let output = ''
  const code = await runRpc(
    app,
    input([
      {
        version: 1,
        requestId: 'initialize',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'create',
        operationId: 'automation-create',
        command: 'automation_create',
        params: {
          interactionKey: ruleKey,
          answer: { value: 'automatic' },
          responseScope: 'once',
        },
      },
      {
        version: 1,
        requestId: 'create-retry',
        operationId: 'automation-create',
        command: 'automation_create',
        params: {
          interactionKey: ruleKey,
          answer: { value: 'automatic' },
          responseScope: 'once',
        },
      },
      {
        version: 1,
        requestId: 'dry-run',
        operationId: 'automation-dry-run',
        command: 'automation_dry_run',
        params: { key: ruleKey },
      },
      {
        version: 1,
        requestId: 'update',
        operationId: 'automation-update',
        command: 'automation_update',
        params: {
          ruleId: 'rule-000002',
          answer: { value: 'updated' },
          responseScope: 'once',
        },
      },
      {
        version: 1,
        requestId: 'disable',
        operationId: 'automation-disable',
        command: 'automation_disable',
        params: { ruleId: 'rule-000002' },
      },
      {
        version: 1,
        requestId: 'delete',
        operationId: 'automation-delete',
        command: 'automation_delete',
        params: { ruleId: 'rule-000002' },
      },
      { version: 1, requestId: 'list', command: 'automation_list' },
      { version: 1, requestId: 'shutdown', command: 'shutdown' },
    ]),
    {
      write(chunk) {
        output += chunk
        return true
      },
    },
  )
  const responses = responsesOf(output)
  assert.equal(code, 0)
  assert.equal(
    responses.some((item) => item.type === 'ack' && item.requestId === 'create'),
    true,
  )
  assert.equal(
    responses.some((item) => item.type === 'ack' && item.requestId === 'dry-run'),
    true,
  )
  assert.equal(
    responses.some((item) => item.type === 'ack' && item.requestId === 'update'),
    true,
  )
  assert.equal(
    responses.some((item) => item.type === 'ack' && item.requestId === 'disable'),
    true,
  )
  assert.equal(
    responses.some((item) => item.type === 'ack' && item.requestId === 'delete'),
    true,
  )
  assert.equal(app.state().rules.length, 0)
  assert.equal(
    app.events().filter((item) => item.event.kind === 'automation.rule.created').length,
    1,
  )
})

test('JSONL cancellation uses the canonical interaction controller', async () => {
  const runtime = new DeterministicInteractionRuntime()
  const app = createBraidApplication({
    fixture: 'deterministic',
    interactionRuntime: runtime,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  const runId = 'run-jsonl-cancel'
  const interactionId = 'jsonl-cancel'
  app.receiveInteraction({
    runId,
    request: {
      id: interactionId,
      kind: 'question',
      title: 'Cancel me',
      answerSpec: {
        fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
      },
    },
  })
  runtime.registerPending(runId, interactionId)
  const view = app.interactionController().views()[0]
  assert.ok(view)
  let output = ''
  const code = await runRpc(
    app,
    input([
      {
        version: 1,
        requestId: 'cancel-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      },
      {
        version: 1,
        requestId: 'cancel-request',
        operationId: 'cancel-operation',
        command: 'cancel_interaction',
        params: {
          runId,
          interactionId,
          ...(view.providerSessionId === undefined
            ? {}
            : { providerSessionId: view.providerSessionId }),
          ...(view.profileDigest === undefined ? {} : { profileDigest: view.profileDigest }),
          ...(view.connectionId === undefined ? {} : { connectionId: view.connectionId }),
          ...(view.workspaceId === undefined ? {} : { workspaceId: view.workspaceId }),
          ...(view.conversationId === undefined ? {} : { conversationId: view.conversationId }),
          ...(view.branchId === undefined ? {} : { branchId: view.branchId }),
          ...(view.model === undefined ? {} : { model: view.model }),
          ...(view.runner === undefined ? {} : { runner: view.runner }),
          ...(view.requestRevision === undefined ? {} : { requestRevision: view.requestRevision }),
        },
      },
      { version: 1, requestId: 'cancel-stop', command: 'shutdown' },
    ]),
    {
      write(chunk) {
        output += chunk
        return true
      },
    },
  )
  const responses = responsesOf(output)
  assert.equal(code, 0)
  assert.equal(
    responses.some(
      (item) =>
        item.type === 'ack' &&
        item.requestId === 'cancel-request' &&
        item.interactionStatus === 'cancelled',
    ),
    true,
  )
  assert.equal(app.state().interactions[0]?.status, 'cancelled')
})

test('W12 the built binary proves plain and JSONL subprocess flows', () => {
  const binary = resolve('dist/bin/braid.js')
  assert.equal(existsSync(binary), true, 'run pnpm build before subprocess proof')
  const plain = spawnSync(
    process.execPath,
    [binary, '--plain', '--fixture', 'deterministic', '--workspace', '/workspace'],
    { input: 'hello subprocess\n/quit\n', encoding: 'utf8' },
  )
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /braid ready/u)
  assert.match(plain.stdout, /Fixture response through pi: hello subprocess/u)
  assert.equal(plain.stdout.includes('\u001b'), false)

  const plainAutomation = spawnSync(
    process.execPath,
    [binary, '--plain', '--fixture', 'deterministic', '--workspace', '/workspace'],
    {
      input:
        JSON.stringify({
          version: 1,
          requestId: 'plain-init',
          command: 'initialize',
          params: { workspace: '/workspace' },
        }) +
        '\n' +
        JSON.stringify({
          version: 1,
          requestId: 'plain-automation',
          operationId: 'plain-automation-operation',
          command: 'automation_create',
          params: {
            request: {
              id: 'plain-template',
              kind: 'question',
              title: 'Plain automation',
              answerSpec: {
                fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
              },
            },
            answer: { value: 'automatic' },
            responseScope: 'once',
          },
        }) +
        '\n' +
        JSON.stringify({ version: 1, requestId: 'plain-stop', command: 'shutdown' }) +
        '\n',
      encoding: 'utf8',
    },
  )
  assert.equal(plainAutomation.status, 0, plainAutomation.stderr)
  assert.match(plainAutomation.stdout, /plain-automation/u)

  const request = {
    version: 1,
    requestId: 'process-create',
    operationId: 'process-automation',
    command: 'automation_create',
    params: {
      request: {
        id: 'process-template',
        kind: 'question',
        title: 'Process automation',
        answerSpec: {
          fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
        },
      },
      answer: { value: 'automatic' },
      responseScope: 'once',
    },
  }
  const rpc = spawnSync(process.execPath, [binary, 'rpc', '--fixture', 'deterministic'], {
    input:
      JSON.stringify({
        version: 1,
        requestId: 'process-init',
        command: 'initialize',
        params: { workspace: '/workspace' },
      }) +
      '\n' +
      JSON.stringify(request) +
      '\n' +
      JSON.stringify({ version: 1, requestId: 'process-stop', command: 'shutdown' }) +
      '\n',
    encoding: 'utf8',
  })
  assert.equal(rpc.status, 0, rpc.stderr)
  const processResponses = responsesOf(rpc.stdout)
  assert.equal(
    processResponses.some((item) => item.type === 'ack' && item.requestId === 'process-create'),
    true,
  )
})

test('cross-process restart reconciles a persisted uncertain response without redispatch', async () => {
  const runtime = new DeterministicInteractionRuntime({ responseStatus: 'transport_error' })
  const first = new InteractionController({
    runtime,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    secretResponseKey: '0123456789abcdef0123456789abcdef',
  })
  first.receive({
    runId: 'run-cross-process',
    request: {
      id: 'cross-process-interaction',
      kind: 'question',
      title: 'Cross-process response',
      answerSpec: {
        fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
      },
    },
  })
  const record = first.state().interactions[0]
  assert.ok(record)
  runtime.registerPending(record.runId, record.interactionId)
  const firstResult = await first.respond({
    runId: record.runId,
    interactionId: record.interactionId,
    ...(record.requestRevision === undefined ? {} : { requestRevision: record.requestRevision }),
    operationId: 'operation-cross-process',
    response: {
      id: record.interactionId,
      outcome: 'accepted',
      data: { value: 'cross-process' },
    },
  })
  assert.equal(firstResult.status, 'transport_error')
  first.dispose()
  const modulePath = resolve('.test-dist/src/index.js')
  const events = Buffer.from(JSON.stringify(first.events()), 'utf8').toString('base64')
  const childSource = `
import { InteractionController } from ${JSON.stringify(modulePath)}
const events = JSON.parse(Buffer.from(process.env.BRAID_EVENTS, 'base64').toString('utf8'))
let responseCalls = 0
const capabilities = {
  kinds: ['question'], answerTypes: ['text'], scopes: ['once'], secretAnswers: false,
  concurrentRequests: true, replay: true, responseIdempotency: true,
}
const identities = (input) => ({
  runId: input.runId, interactionId: input.interactionId,
  ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
  ...(input.requestRevision === undefined ? {} : { requestRevision: input.requestRevision }),
  ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
  ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
  ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
})
const runtime = {
  capabilities,
  async respondToInteraction(input) {
    responseCalls += 1
    return { status: 'transport_error', ...identities(input) }
  },
  async reconcileInteraction(input) {
    return { status: 'resolved', ...identities(input), outcome: 'accepted' }
  },
}
const controller = new InteractionController({
  runtime,
  clock: { now: () => '2026-08-01T00:00:00.000Z' },
  ids: { next: (kind) => kind + '-child' },
  initialEvents: events,
  secretResponseKey: '0123456789abcdef0123456789abcdef',
})
const record = controller.state().interactions[0]
const result = await controller.respond({
  runId: record.runId,
  interactionId: record.interactionId,
  ...(record.requestRevision === undefined ? {} : { requestRevision: record.requestRevision }),
  operationId: 'operation-cross-process',
  response: { id: record.interactionId, outcome: 'accepted', data: { value: 'cross-process' } },
})
process.stdout.write(JSON.stringify({ result, state: controller.state(), responseCalls }))
`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    env: { ...process.env, BRAID_EVENTS: events },
    encoding: 'utf8',
  })
  assert.equal(child.status, 0, child.stderr)
  const proof = JSON.parse(child.stdout) as {
    readonly result: { readonly status: string }
    readonly state: { readonly interactions: readonly { readonly status: string }[] }
    readonly responseCalls: number
  }
  assert.equal(proof.result.status, 'accepted')
  assert.equal(proof.state.interactions[0]?.status, 'resolved')
  assert.equal(proof.responseCalls, 0)
})
