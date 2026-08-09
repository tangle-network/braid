import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  InteractionRequest,
  InteractionRequestMaterial,
} from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import {
  createInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'
import { parseRequest } from '../src/views/headless/rpc-parser.js'
import type { InteractionView } from '../src/views/shared/models.js'
import { InteractionShell } from '../src/views/tui/interaction.js'
import { createBraidTheme } from '../src/views/tui/theme.js'

function request(id: string, runId = 'run-request'): InteractionRequest {
  const material: InteractionRequestMaterial = {
    id,
    kind: 'question',
    title: 'Continue?',
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    binding: {
      runId,
      provider: 'test-provider',
      environmentId: 'environment-test',
      sessionId: 'session-test',
      executionId: runId,
      interactionId: id,
    },
  }
  return createInteractionRequest(material)
}

function interactionExecution(source: InteractionRequest): {
  readonly execution: ExecutionPort
  readonly release: () => void
  readonly responses: () => number
} {
  let release: (() => void) | undefined
  let responses = 0
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      yield {
        type: 'interaction',
        request: rebindInteractionRequest(source, {
          ...source.binding,
          runId: input.runId,
          executionId: input.runId,
        }),
      }
      await new Promise<void>((resolve) => {
        release = resolve
        if (input.signal.aborted) resolve()
        else input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    respondInteraction: async (input) => {
      responses += 1
      release?.()
      return { operationId: input.command.operationId, outcome: 'accepted' as const }
    },
  }
  return { execution, release: () => release?.(), responses: () => responses }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for interaction')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function ack(
  responses: readonly BraidResponse[],
  requestId: string,
): BraidResponse & { type: 'ack' } {
  const response = responses.find(
    (candidate) => candidate.type === 'ack' && candidate.requestId === requestId,
  )
  assert(response && response.type === 'ack', `missing acknowledgement for ${requestId}`)
  return response
}

test('JSONL persists the full automation lifecycle and applies a matching rule', async () => {
  const source = request('interaction-jsonl')
  const provider = interactionExecution(source)
  const app = createBraidApplication({ fixture: 'deterministic', execution: provider.execution })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'operation-send-jsonl', text: 'hold for interaction' })
  await waitFor(() => app.state().runs[0]?.interactions.length === 1)
  const run = app.state().runs[0]
  const interaction = run?.interactions[0]
  assert(run && interaction)
  const responses: BraidResponse[] = []
  const commands = [
    {
      version: 1,
      requestId: 'jsonl-init',
      command: 'initialize',
      params: { workspace: '/workspace' },
    },
    {
      version: 1,
      requestId: 'jsonl-create',
      operationId: 'operation-automation-create',
      command: 'automation_create',
      params: {
        ruleId: 'rule-jsonl',
        runId: run.id,
        interactionId: interaction.request.id,
        answer: { continue: true },
        responseScope: 'once',
      },
    },
    {
      version: 1,
      requestId: 'jsonl-update',
      operationId: 'operation-automation-update',
      command: 'automation_update',
      params: {
        ruleId: 'rule-jsonl',
        runId: run.id,
        interactionId: interaction.request.id,
        answer: { continue: false },
        responseScope: 'once',
      },
    },
    {
      version: 1,
      requestId: 'jsonl-dry-run',
      operationId: 'operation-automation-dry-run',
      command: 'automation_dry_run',
      params: { runId: run.id, interactionId: interaction.request.id },
    },
    {
      version: 1,
      requestId: 'jsonl-disable',
      operationId: 'operation-automation-disable',
      command: 'automation_disable',
      params: { ruleId: 'rule-jsonl' },
    },
    {
      version: 1,
      requestId: 'jsonl-list-disabled',
      command: 'automation_list',
      params: {},
    },
    {
      version: 1,
      requestId: 'jsonl-delete',
      operationId: 'operation-automation-delete',
      command: 'automation_delete',
      params: { ruleId: 'rule-jsonl' },
    },
    {
      version: 1,
      requestId: 'jsonl-list-empty',
      command: 'automation_list',
      params: {},
    },
  ]
  async function* input(): AsyncGenerator<string> {
    yield `${commands.map((command) => JSON.stringify(command)).join('\n')}\n`
  }
  const code = await runRpc(createApplicationUiController(app), input(), {
    write: (chunk) => {
      responses.push(
        ...chunk
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as BraidResponse),
      )
      return true
    },
  })
  await send.completion

  assert.equal(code, 0)
  const created = ack(responses, 'jsonl-create')
  assert.deepEqual(
    created.type === 'ack' ? (created.result as { id: string }).id : undefined,
    'rule-jsonl',
  )
  const dryRun = ack(responses, 'jsonl-dry-run')
  assert.equal(
    dryRun.type === 'ack' ? (dryRun.result as { status: string }).status : undefined,
    'eligible',
  )
  const disabled = ack(responses, 'jsonl-list-disabled')
  assert.equal(
    disabled.type === 'ack' ? (disabled.result as Array<{ enabled: boolean }>)[0]?.enabled : true,
    false,
  )
  const empty = ack(responses, 'jsonl-list-empty')
  assert.deepEqual(empty.type === 'ack' ? empty.result : undefined, [])
  assert.equal(provider.responses(), 1)
  assert.equal(app.state().runs[0]?.interactions[0]?.status, 'resolved')
  assert.equal(app.state().feedbackDecisions.at(-1)?.automated, true)
  provider.release()
})

test('automation commands work through the command controller and Escape remains an explicit cancel', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  const interactionRequest = request('interaction-command')
  const created = await controller.dispatch({
    type: 'run-command',
    command: 'automate',
    operationId: 'operation-command-create',
    args: [
      'create',
      JSON.stringify({
        ruleId: 'rule-command',
        request: interactionRequest,
        answer: { continue: true },
        responseScope: 'once',
      }),
    ],
  })
  assert.equal(created.kind, 'accepted')
  assert.equal(app.automation.list()[0]?.id, 'rule-command')

  const updated = await controller.dispatch({
    type: 'run-command',
    command: 'automate',
    operationId: 'operation-command-update',
    args: ['update', JSON.stringify({ ruleId: 'rule-command', maximumUses: 3 })],
  })
  assert.equal(updated.kind, 'accepted')
  assert.equal(app.automation.list()[0]?.maximumUses, 3)

  const listed = await controller.dispatch({
    type: 'run-command',
    operationId: 'operation-command-list',
    command: 'automate',
    args: ['list'],
  })
  assert.equal(listed.kind, 'accepted')
  assert.equal((listed.data as Array<{ id: string }>)[0]?.id, 'rule-command')

  const responses: unknown[] = []
  const shell: InteractionView = {
    runId: 'run-keyboard',
    interactionId: 'interaction-keyboard',
    kind: 'question',
    prompt: 'Continue?',
    answerSpec: { kind: 'boolean', required: true },
    allowedOutcomes: ['accept', 'cancel'],
    queuePosition: 0,
    secret: false,
  }
  const interactionShell = new InteractionShell(
    shell,
    createBraidTheme({ colors: false, reducedMotion: true }),
    (response) => responses.push(response),
  )
  interactionShell.handleInput('\u001b')
  interactionShell.handleInput('\u001b')
  assert.deepEqual(responses, [{ outcome: 'cancel' }])

  const parsed = parseRequest(
    JSON.stringify({
      version: 1,
      requestId: 'cancel-parse',
      operationId: 'operation-cancel-parse',
      command: 'cancel_interaction',
      params: { runId: 'run-keyboard', interactionId: 'interaction-keyboard' },
    }),
  )
  assert.equal(parsed.command, 'cancel_interaction')
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({
          version: 1,
          requestId: 'response-parse',
          operationId: 'operation-response-parse',
          command: 'respond_interaction',
          params: {
            runId: 'run-keyboard',
            interactionId: 'interaction-keyboard',
            response: { id: 'another-interaction', outcome: 'cancelled' },
          },
        }),
      ),
    /response\.id must match interactionId/u,
  )
})
