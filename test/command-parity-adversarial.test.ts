import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COMMAND_DEFINITIONS,
  commandDefinition,
  parseCommandInput,
} from '../src/views/shared/command-registry.js'
import { SHARED_COMMAND_TABLE } from '../src/views/shared/command-table.js'
import {
  HEADLESS_COMMAND_NAMES,
  type HeadlessCommandName,
} from '../src/views/shared/headless-commands.js'
import { parseRequest, RpcParseError } from '../src/views/headless/rpc-parser.js'

test('every shared command keeps its mutating headless commands inside its declared set', () => {
  for (const entry of SHARED_COMMAND_TABLE) {
    const declared = entry.headlessCommands as readonly HeadlessCommandName[]
    for (const mutating of entry.mutatingHeadlessCommands) {
      assert.ok(
        declared.includes(mutating),
        `${entry.name} declares mutating ${mutating} outside its headless set`,
      )
    }
  }
})

test('headless identity is unique and well-formed and every capability is non-empty', () => {
  const identities = COMMAND_DEFINITIONS.map((definition) => definition.headlessIdentity)
  for (const definition of COMMAND_DEFINITIONS) {
    assert.equal(definition.headlessIdentity, `braid.command.${definition.name}`)
    assert.ok(definition.capability.length > 0, `${definition.name} has an empty capability`)
  }
  assert.equal(new Set(identities).size, identities.length)
})

test('aliases resolve to their owning command definition', () => {
  assert.equal(commandDefinition('exit')?.name, 'quit')
  assert.equal(commandDefinition('?')?.name, 'help')
  assert.equal(commandDefinition('exit'), commandDefinition('quit'))
})

test('command tokenization honors quotes, escapes, and rejects unclosed quotes', () => {
  const quoted = parseCommandInput('/branch "hello world" msg')
  assert.equal(quoted.kind, 'command')
  if (quoted.kind !== 'command') assert.fail('expected command')
  assert.deepEqual(quoted.args, ['hello world', 'msg'])

  const escaped = parseCommandInput('/queue a\\ b c')
  assert.equal(escaped.kind, 'command')
  if (escaped.kind !== 'command') assert.fail('expected command')
  assert.deepEqual(escaped.args, ['a b', 'c'])

  const unclosed = parseCommandInput("/branch 'unclosed")
  assert.equal(unclosed.kind, 'invalid')
  if (unclosed.kind !== 'invalid') assert.fail('expected invalid')
  assert.match(unclosed.message, /unclosed quote/iu)
})

test('every headless command defines a parameter allow-list by rejecting an unknown field', () => {
  for (const command of HEADLESS_COMMAND_NAMES) {
    let error: RpcParseError | undefined
    try {
      parseRequest(
        JSON.stringify({
          version: 1,
          requestId: `r-${command}`,
          operationId: 'op-probe',
          command,
          params: { __parity_probe: 1 },
        }),
      )
    } catch (caught) {
      error = caught instanceof RpcParseError ? caught : undefined
    }
    assert.ok(error, `${command} accepted an unknown parameter`)
    assert.equal(error?.code, 'INVALID_PARAMS')
    assert.match(error?.message ?? '', /unknown field/u)
  }
})
