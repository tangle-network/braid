import assert from 'node:assert/strict'

import { eventKinds, redactedReceipt } from './evidence.mjs'

export function runState(state, runId) {
  return state?.runs?.find((run) => run.id === runId)
}

export function transcriptFor(state, runId) {
  return (state?.messages ?? [])
    .filter((message) => message.runId === runId)
    .map((message) => ({ role: message.role, text: message.text, status: message.status }))
}

export function assistantText(state, runId) {
  return transcriptFor(state, runId).findLast((message) => message.role === 'assistant')?.text ?? ''
}

export function providerIdentity(details, state, runId) {
  return (
    details?.data?.providerSessionId ??
    details?.data?.receipt?.providerSessionId ??
    runState(state, runId)?.providerSessionId
  )
}

export function continuationCapability(details, state, runId) {
  return Boolean(
    details?.data?.capabilities?.sessions?.continue ??
      details?.data?.receipt?.capabilities?.sessions?.continue ??
      state?.runs?.find((run) => run.id === runId)?.capabilities?.sessions?.continue,
  )
}

export async function dispatchTurn(session, input) {
  const responseStart = session.responses.length
  const startedAt = Date.now()
  const send = session.send(
    'send',
    { conversationId: input.conversationId, branchId: input.branchId, text: input.prompt },
    input.operationId,
  )
  const sendAck = await session.waitFor(
    `${input.label} acknowledgement`,
    (response) => response.requestId === send.requestId && response.type === 'ack',
    input.timeoutMs,
  )
  assert.equal(sendAck.type, 'ack')
  assert.equal(typeof sendAck.runId, 'string')
  await session.waitFor(
    `${input.label} terminal state`,
    (response) => {
      const run = response.type === 'state' ? runState(response.state, sendAck.runId) : undefined
      return Boolean(
        response.requestId === send.requestId &&
          run &&
          !['running', 'streaming', 'starting', 'reconnecting', 'cancelling'].includes(run.status),
      )
    },
    input.timeoutMs,
  )
  const detailsRequest = session.send('get_details', { entityType: 'run', entityId: sendAck.runId })
  const detailsAck = await session.waitFor(
    `${input.label} details`,
    (response) => response.requestId === detailsRequest.requestId && response.type === 'ack',
    30_000,
  )
  const state = await session.state('full', 30_000)
  const run = runState(state.state, sendAck.runId)
  const details = detailsAck.result
  const receipt = redactedReceipt(details)
  assert.ok(receipt?.digest, `${input.label} did not expose an immutable receipt digest`)
  assert.ok(run, `${input.label} did not remain in the full state`)
  return {
    label: input.label,
    operationId: send.operationId,
    runId: sendAck.runId,
    prompt: input.prompt,
    ack: sendAck,
    terminalState: run,
    eventTypes: eventKinds(session.responses.slice(responseStart)),
    output: assistantText(state.state, sendAck.runId),
    transcript: transcriptFor(state.state, sendAck.runId),
    providerSessionId: providerIdentity(details, state.state, sendAck.runId),
    continuation: continuationCapability(details, state.state, sendAck.runId),
    receipt,
    details,
    elapsedMs: Date.now() - startedAt,
    state: state.state,
  }
}
