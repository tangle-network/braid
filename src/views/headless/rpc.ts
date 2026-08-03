import { AppError, type BraidApplication } from '../../app/application.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { BraidEventEnvelope } from '../../domain/events.js'
import { BRAID_PROTOCOL_VERSION, type BraidResponse, type ErrorResponse } from './protocol.js'
import { linesOf, parseRpcRequest, requestIdOf, type RpcInput } from './rpc-request.js'
import { RpcReplayStore } from './rpc-replay.js'

export type { RpcInput } from './rpc-request.js'

export interface RpcOutput {
  write(chunk: string): boolean
}

export { RPC_REPLAY_MAX_BYTES, RPC_REPLAY_MAX_ENTRIES } from './rpc-replay.js'

function errorResponse(error: unknown, requestId?: string): ErrorResponse {
  if (error instanceof AppError) {
    return {
      version: 1,
      type: 'error',
      ...(requestId ? { requestId } : {}),
      code: error.code,
      message: error.message,
      retryable: false,
    }
  }
  return {
    version: 1,
    type: 'error',
    ...(requestId ? { requestId } : {}),
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}

function eventResponse(envelope: BraidEventEnvelope): BraidResponse {
  return {
    version: BRAID_PROTOCOL_VERSION,
    type: 'event',
    ...(envelope.eventId === undefined ? {} : { eventId: envelope.eventId }),
    sequence: envelope.sequence,
    revision: envelope.revision,
    event: envelope.event,
  }
}

export async function runRpc(
  app: BraidApplication,
  input: RpcInput,
  output: RpcOutput,
): Promise<number> {
  let initialized = false
  let subscribed = false
  let bufferedEvents: BraidEventEnvelope[] | undefined
  const replay = new RpcReplayStore()
  const write = (response: BraidResponse) => output.write(`${JSON.stringify(response)}\n`)
  const unsubscribe = app.subscribe((_state, envelope) => {
    if (!subscribed) return
    if (bufferedEvents) bufferedEvents.push(envelope)
    else write(eventResponse(envelope))
  })

  try {
    for await (const line of linesOf(input)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = undefined
      }
      const requestId = requestIdOf(parsed)
      let requestRecord: ReturnType<RpcReplayStore['add']> | undefined
      try {
        const request = parseRpcRequest(line)
        const digest = canonicalDigest(request)
        const previous = replay.get(request.requestId)
        if (previous) {
          if (previous.digest !== digest) {
            write(
              errorResponse(
                new AppError(
                  'REQUEST_ID_CONFLICT',
                  `requestId ${request.requestId} was already used with different input`,
                ),
                request.requestId,
              ),
            )
          } else if (!previous.replayable) {
            write(
              errorResponse(
                new AppError(
                  'REQUEST_REPLAY_UNAVAILABLE',
                  `The cached response for requestId ${request.requestId} exceeded the replay limit`,
                ),
                request.requestId,
              ),
            )
          } else {
            replay.replay(previous, (response) => output.write(response))
          }
          continue
        }
        requestRecord = replay.add(request.requestId, digest)
        const respond = (response: BraidResponse) => {
          if (requestRecord) replay.remember(requestRecord, response, (line) => output.write(line))
          else write(response)
        }
        if (!initialized && request.command !== 'initialize') {
          throw new AppError('INITIALIZE_REQUIRED', 'The first command must be initialize')
        }
        switch (request.command) {
          case 'initialize': {
            if (initialized) throw new AppError('ALREADY_INITIALIZED', 'Already initialized')
            subscribed = request.params.subscribe ?? false
            app.initialize(request.params.workspace)
            initialized = true
            const state = app.state()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              revision: state.revision,
            })
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: state.revision,
              state,
            })
            break
          }
          case 'get_state': {
            const state = app.state()
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: state.revision,
              state,
            })
            break
          }
          case 'send': {
            bufferedEvents = []
            const receipt = app.send({
              operationId: request.operationId,
              text: request.params.text,
              ...(request.params.conversationId
                ? { conversationId: request.params.conversationId }
                : {}),
              ...(request.params.branchId ? { branchId: request.params.branchId } : {}),
            })
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              operationId: request.operationId,
              revision: receipt.revision,
              replayed: receipt.replayed,
            })
            for (const envelope of bufferedEvents) write(eventResponse(envelope))
            bufferedEvents = undefined
            const state = await receipt.completion
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: state.revision,
              state,
            })
            break
          }
          case 'respond_interaction': {
            bufferedEvents = []
            const result = await app.respondInteraction({
              runId: request.params.runId,
              interactionId: request.params.interactionId,
              ...(request.params.providerSessionId === undefined
                ? {}
                : { providerSessionId: request.params.providerSessionId }),
              ...(request.params.profileDigest === undefined
                ? {}
                : { profileDigest: request.params.profileDigest }),
              ...(request.params.connectionId === undefined
                ? {}
                : { connectionId: request.params.connectionId }),
              ...(request.params.workspaceId === undefined
                ? {}
                : { workspaceId: request.params.workspaceId }),
              ...(request.params.runner === undefined ? {} : { runner: request.params.runner }),
              operationId: request.operationId,
              response: request.params.response,
            })
            const state = app.state()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              operationId: request.operationId,
              replayed: result.replayed,
              interactionStatus: result.status,
              ...(result.reason === undefined ? {} : { reason: result.reason }),
              revision: state.revision,
            })
            for (const envelope of bufferedEvents) write(eventResponse(envelope))
            bufferedEvents = undefined
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: state.revision,
              state: app.state(),
            })
            break
          }
          case 'shutdown': {
            const state = await app.waitForIdle()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              revision: state.revision,
            })
            return 0
          }
          default: {
            const exhaustive: never = request
            return exhaustive
          }
        }
      } catch (error) {
        bufferedEvents = undefined
        const response = errorResponse(error, requestId)
        if (requestRecord) replay.remember(requestRecord, response, (line) => output.write(line))
        else write(response)
      }
    }
    return 0
  } finally {
    unsubscribe()
  }
}
