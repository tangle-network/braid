import assert from 'node:assert/strict'
import test from 'node:test'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { RPC_COMMAND_NAMES } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'
import {
  COMMAND_DEFINITIONS,
  commandIntent,
  isMutatingCommand,
  parseCommandInput,
} from '../src/views/shared/command-registry.js'
import { SHARED_COMMAND_TABLE } from '../src/views/shared/command-table.js'
import {
  HEADLESS_COMMAND_NAMES,
  isMutatingHeadlessCommand,
  MUTATING_HEADLESS_COMMANDS,
} from '../src/views/shared/headless-commands.js'

const REQUIRED_HEADLESS = [
  'initialize',
  'get_state',
  'subscribe',
  'unsubscribe',
  'list_profiles',
  'select_profile',
  'validate_profile',
  'save_profile',
  'list_connections',
  'upsert_connection',
  'test_connection',
  'select_connection',
  'remove_connection',
  'set_run_override',
  'new_conversation',
  'list_conversations',
  'open_conversation',
  'rename_conversation',
  'archive_conversation',
  'delete_conversation',
  'set_draft',
  'import_conversation',
  'send',
  'queue',
  'remove_queued',
  'steer',
  'cancel',
  'detach',
  'reconnect',
  'reconcile',
  'respond_interaction',
  'cancel_interaction',
  'automation_create',
  'automation_update',
  'automation_dry_run',
  'automation_disable',
  'automation_delete',
  'automation_list',
  'cancel_run',
  'branch',
  'clone',
  'plan_fork',
  'execute_fork',
  'ask',
  'analyze',
  'compare',
  'promote_analysis',
  'get_graph',
  'get_activity',
  'get_details',
  'steer_worker',
  'cancel_worker',
  'export',
  'shutdown',
] as const

async function* lines(linesToSend: readonly (object | string)[]): AsyncGenerator<string> {
  for (const line of linesToSend)
    yield `${typeof line === 'string' ? line : JSON.stringify(line)}\n`
}

test('headless registry exposes every required JSONL command exactly once', () => {
  assert.deepEqual([...HEADLESS_COMMAND_NAMES], [...REQUIRED_HEADLESS])
  assert.deepEqual([...RPC_COMMAND_NAMES], [...REQUIRED_HEADLESS])
  assert.equal(new Set(HEADLESS_COMMAND_NAMES).size, HEADLESS_COMMAND_NAMES.length)
})

test('all mutating JSONL commands reject absent caller operation identifiers', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  const output: string[] = []
  const requests: object[] = [
    { version: 1, requestId: 'init', command: 'initialize', params: { workspace: '/workspace' } },
  ]
  for (const [index, command] of MUTATING_HEADLESS_COMMANDS.entries()) {
    requests.push({
      version: 1,
      requestId: `mutation-${index}`,
      command,
      params: command === 'send' ? { text: 'message' } : {},
    })
  }
  requests.push({
    version: 1,
    requestId: 'stop',
    operationId: 'op-contract-stop',
    command: 'shutdown',
  })
  await runRpc(createApplicationUiController(app), lines(requests), {
    write: (chunk) => {
      output.push(chunk)
      return true
    },
  })
  const errors = output
    .map((line) => JSON.parse(line) as { type: string; code?: string })
    .filter((response) => response.type === 'error')
  assert.equal(errors.length, MUTATING_HEADLESS_COMMANDS.length)
  assert.equal(
    errors.every((response) => response.code === 'OPERATION_ID_REQUIRED'),
    true,
  )
})

test('unknown slash commands stay local and double slash sends ordinary prompt text', () => {
  const unknown = parseCommandInput('/analize failure')
  assert.equal(unknown.kind, 'unknown')
  if (unknown.kind !== 'unknown') assert.fail('expected unknown command')
  assert.ok(unknown.suggestions.includes('analyze'))
  const prompt = parseCommandInput('//help')
  assert.deepEqual(prompt, { kind: 'prompt', text: '/help' })
})

test('the command registry owns typed intents for local and headless command paths', () => {
  assert.equal(
    COMMAND_DEFINITIONS.every((definition) => typeof definition.intent === 'function'),
    true,
  )
  assert.deepEqual(commandIntent('help', ['keys']), {
    type: 'open-surface',
    surface: 'help',
    query: 'keys',
  })
  assert.deepEqual(commandIntent('profile', ['reviewer'], 'op-profile'), {
    type: 'run-command',
    command: 'profile',
    args: ['reviewer'],
    operationId: 'op-profile',
  })
  assert.deepEqual(commandIntent('quit', []), { type: 'shutdown', operationId: '' })
  assert.deepEqual(commandIntent('reconnect', [], 'op-reconnect'), {
    type: 'run-command',
    command: 'reconnect',
    args: [],
    operationId: 'op-reconnect',
  })
})

test('keyboard and headless mutation metadata comes from one exact table', () => {
  const definitions = new Map(
    COMMAND_DEFINITIONS.map((definition) => [definition.name, definition]),
  )
  const expectedMutations = new Set(MUTATING_HEADLESS_COMMANDS)
  for (const entry of SHARED_COMMAND_TABLE) {
    const definition = definitions.get(entry.name)
    assert(definition, `${entry.name} has no keyboard definition`)
    assert.equal(definition.requiresOperationId, entry.requiresOperationId)
    assert.equal(isMutatingCommand(entry.name), entry.requiresOperationId)
    for (const command of entry.headlessCommands)
      assert.ok(HEADLESS_COMMAND_NAMES.includes(command), `${entry.name} maps unknown ${command}`)
    assert.deepEqual([...definition.mutatingHeadlessCommands], [...entry.mutatingHeadlessCommands])
    for (const command of entry.mutatingHeadlessCommands) {
      assert.equal(expectedMutations.has(command), true)
      assert.equal(isMutatingHeadlessCommand(command), true)
    }
  }
  assert.equal(isMutatingHeadlessCommand('list_conversations'), false)
  assert.equal(isMutatingHeadlessCommand('list_profiles'), false)
  assert.equal(isMutatingHeadlessCommand('list_connections'), false)
})

test('view and headless snapshots are deeply immutable', () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  const view = controller.view()
  const state = controller.state()
  const event = controller.events()[0]
  assert.equal(Object.isFrozen(view), true)
  assert.equal(Object.isFrozen(view.activity), true)
  assert.equal(Object.isFrozen(view.capabilities['run.send']), true)
  assert.equal(Object.isFrozen(state), true)
  assert.equal(Object.isFrozen(state.messages), true)
  assert.equal(Object.isFrozen(event), true)
  assert.equal(Object.isFrozen(event?.payload), true)
})

test('headless malformed and changed request bodies have distinct typed errors', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  const output: string[] = []
  const requests = [
    '{bad json',
    JSON.stringify({
      version: 1,
      requestId: 'init',
      command: 'initialize',
      params: { workspace: '/workspace' },
    }),
    JSON.stringify({ version: 1, requestId: 'same', command: 'get_state' }),
    JSON.stringify({
      version: 1,
      requestId: 'bad-param',
      command: 'get_state',
      params: { projection: 3 },
    }),
    JSON.stringify({
      version: 1,
      requestId: 'same',
      command: 'get_state',
      params: { projection: 'summary' },
    }),
    JSON.stringify({
      version: 1,
      requestId: 'stop',
      operationId: 'op-contract-stop-2',
      command: 'shutdown',
    }),
  ]
  await runRpc(createApplicationUiController(app), lines(requests), {
    write: (chunk) => {
      output.push(chunk)
      return true
    },
  })
  const errors = output
    .map((line) => JSON.parse(line) as { type: string; code?: string })
    .filter((response) => response.type === 'error')
  assert.deepEqual(
    errors.map((response) => response.code),
    ['MALFORMED_JSON', 'INVALID_PARAMS', 'REQUEST_ID_CONFLICT'],
  )
})
