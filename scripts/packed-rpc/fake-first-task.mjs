#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.BRAID_FIRST_TASK_FAKE_MODE ?? 'active'
const requestLog = process.env.BRAID_FIRST_TASK_FAKE_REQUEST_LOG
const runId = 'run-example'
const state = {
  schemaVersion: 1,
  revision: 0,
  sequence: 0,
  workspace: process.cwd(),
  conversationId: 'conversation-example',
  branchId: 'branch-main',
  messages: [],
  runs: [],
  queue: [],
  activeRunId: null,
  activeRuns: [],
  interactions: [],
}
const view = {
  profileName: 'example profile',
  runner: 'fixture runner',
  connection: 'fixture connection',
  queue: [],
  interactions: [],
  capabilities: {
    'run.send': { available: true, source: 'application' },
    'run.cancel': { available: true, source: 'application' },
    'run.detach': { available: mode === 'interaction-detach', source: 'application' },
    'run.reconnect': { available: true, source: 'application' },
  },
}

function emit(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

function stateResponse(requestId) {
  return {
    version: 1,
    type: 'state',
    requestId,
    revision: state.revision,
    projection: 'full',
    state: structuredClone(state),
    view: structuredClone(view),
  }
}

function setRun(
  status,
  withInteraction = false,
  withOutput = false,
  sendOperationId = 'op-example-send',
) {
  const run = { id: runId, operationId: sendOperationId, status }
  state.runs = [run]
  state.activeRunId = ['running', 'waiting'].includes(status) ? runId : null
  state.activeRuns =
    state.activeRunId === null
      ? []
      : [{ runId, conversationId: state.conversationId, branchId: state.branchId }]
  state.interactions = withInteraction
    ? [
        {
          runId,
          interactionId: 'interaction-example',
          kind: 'permission',
          prompt: 'Do not print this secret prompt',
          allowedOutcomes: ['accept', 'reject'],
          secret: true,
        },
      ]
    : []
  view.interactions = structuredClone(state.interactions)
  state.messages = withOutput
    ? [
        {
          id: 'message-output',
          role: 'assistant',
          text: 'Public fixture output',
          status: 'complete',
          runId,
        },
      ]
    : []
}

if (mode === 'active') setRun('running')

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line)
  if (requestLog) appendFileSync(requestLog, `${JSON.stringify(request)}\n`)
  if (request.command === 'initialize') {
    emit({ version: 1, type: 'ack', requestId: request.requestId, revision: state.revision })
    emit(stateResponse(request.requestId))
  } else if (request.command === 'get_state') {
    emit(stateResponse(request.requestId))
  } else if (request.command === 'send') {
    if (mode === 'ambiguous-send') {
      setRun('running', false, false, request.operationId)
      emit({
        version: 1,
        type: 'error',
        requestId: request.requestId,
        code: 'RESPONSE_LOST',
        message: 'The send acknowledgement could not be confirmed.',
        retryable: true,
      })
      continue
    }
    if (mode === 'interaction-cancel' || mode === 'interaction-detach') setRun('waiting', true)
    else if (mode === 'timeout') setRun('running')
    else if (mode === 'missing-output') setRun('completed')
    else setRun('completed', false, true)
    emit({
      version: 1,
      type: 'ack',
      requestId: request.requestId,
      revision: state.revision,
      operationId: request.operationId,
      runId,
    })
  } else if (request.command === 'cancel') {
    if (request.params.runId !== runId) throw new Error('cancel was not scoped to the example run')
    setRun('cancelled')
    emit({
      version: 1,
      type: 'ack',
      requestId: request.requestId,
      revision: state.revision,
      outcome: 'accepted',
    })
  } else if (request.command === 'detach') {
    if (request.params.runId !== runId) throw new Error('detach was not scoped to the example run')
    setRun('detached', true)
    emit({
      version: 1,
      type: 'ack',
      requestId: request.requestId,
      revision: state.revision,
      outcome: 'accepted',
    })
    emit(stateResponse(request.requestId))
  } else if (request.command === 'shutdown') {
    emit({ version: 1, type: 'ack', requestId: request.requestId, revision: state.revision })
    process.stdout.write('', () => process.exit(0))
  } else {
    emit({
      version: 1,
      type: 'error',
      requestId: request.requestId,
      code: 'UNKNOWN_COMMAND',
      message: `Unexpected command ${request.command}`,
      retryable: false,
    })
  }
}
