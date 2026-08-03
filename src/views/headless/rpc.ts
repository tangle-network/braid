import type { BraidUiController, UiEvent } from '../shared/intents.js'
import { canonicalDigest } from '../shared/canonical.js'
import { redactSensitiveText, sanitizeTerminalText } from '../shared/sanitize.js'
import {
  BRAID_PROTOCOL_VERSION,
  type BraidResponse,
  type ErrorResponse,
  type StateProjection,
} from './protocol.js'
import { linesOf, parseRequest, requestIdOf, RpcParseError } from './rpc-parser.js'
import {
  RPC_REPLAY_MAX_BYTES,
  RPC_REPLAY_MAX_ENTRIES,
  type RequestRecord,
  type RpcInput,
  type RpcOutput,
} from './rpc-types.js'

export type { RpcInput, RpcOutput }
export { RPC_REPLAY_MAX_BYTES, RPC_REPLAY_MAX_ENTRIES }

function errorResponse(error: unknown, requestId?: string): ErrorResponse {
  if (error instanceof RpcParseError) {
    return {
      version: BRAID_PROTOCOL_VERSION,
      type: 'error',
      ...(requestId ? { requestId } : {}),
      code: error.code,
      message: sanitizeTerminalText(error.message),
      retryable: false,
      ...(error.choices ? { choices: error.choices } : {}),
    }
  }
  if (error && typeof error === 'object' && 'kind' in error) {
    const result = error as {
      readonly kind?: string
      readonly code?: string
      readonly reason?: string
      readonly message?: string
      readonly retryable?: boolean
    }
    if (result.kind === 'unavailable') {
      return {
        version: BRAID_PROTOCOL_VERSION,
        type: 'error',
        ...(requestId ? { requestId } : {}),
        code: result.code ?? 'CAPABILITY_UNAVAILABLE',
        message: sanitizeTerminalText(result.reason ?? 'Capability is unavailable'),
        retryable: false,
      }
    }
    if (result.kind === 'error') {
      return {
        version: BRAID_PROTOCOL_VERSION,
        type: 'error',
        ...(requestId ? { requestId } : {}),
        code: result.code ?? 'INTERNAL_ERROR',
        message: sanitizeTerminalText(result.message ?? 'The command failed'),
        retryable: result.retryable ?? false,
      }
    }
  }
  return {
    version: BRAID_PROTOCOL_VERSION,
    type: 'error',
    ...(requestId ? { requestId } : {}),
    code: 'INTERNAL_ERROR',
    message: redactSensitiveText(error instanceof Error ? error.message : 'Internal error'),
    retryable: false,
  }
}

function stateResponse(
  controller: BraidUiController,
  requestId: string,
  projection: StateProjection = 'full',
): BraidResponse {
  const view = controller.view()
  if (projection === 'summary') {
    const state = controller.state()
    return {
      version: BRAID_PROTOCOL_VERSION,
      type: 'state',
      requestId,
      revision: view.revision,
      projection,
      state: {
        schemaVersion: state.schemaVersion,
        revision: state.revision,
        sequence: state.sequence,
        workspace: state.workspace,
        conversationId: state.conversationId,
        branchId: state.branchId,
        profileName: view.profileName,
        status: view.status,
        messageCount: state.messages.length,
        runCount: state.runs.length,
        interactionCount: view.interactions.length,
        activeRunId: state.activeRunId,
        lastError: state.lastError,
      },
    }
  }
  return {
    version: BRAID_PROTOCOL_VERSION,
    type: 'state',
    requestId,
    revision: view.revision,
    projection,
    state: controller.state(),
    view,
  }
}

function eventResponse(event: UiEvent): BraidResponse {
  return {
    version: BRAID_PROTOCOL_VERSION,
    type: 'event',
    sequence: event.sequence,
    revision: event.revision,
    event,
  }
}

export async function runRpc(
  controller: BraidUiController,
  input: RpcInput,
  output: RpcOutput,
): Promise<number> {
  let initialized = false
  let subscribed = false
  let bufferedEvents: UiEvent[] | undefined
  const pendingCompletions = new Set<Promise<void>>()
  const requests = new Map<string, RequestRecord>()
  let replayBytes = 0
  const write = (response: BraidResponse) => output.write(`${JSON.stringify(response)}\n`)
  const trimReplayHistory = () => {
    while (requests.size > RPC_REPLAY_MAX_ENTRIES || replayBytes > RPC_REPLAY_MAX_BYTES) {
      const oldest = requests.entries().next().value as [string, RequestRecord] | undefined
      if (!oldest) break
      requests.delete(oldest[0])
      replayBytes -= oldest[1].bytes
    }
  }
  const rememberResponse = (record: RequestRecord, response: BraidResponse) => {
    const line = `${JSON.stringify(response)}\n`
    const bytes = new TextEncoder().encode(line).byteLength
    if (record.replayable && record.bytes + bytes <= RPC_REPLAY_MAX_BYTES) {
      record.responses.push(line)
      record.bytes += bytes
      replayBytes += bytes
      trimReplayHistory()
    } else if (record.replayable) {
      replayBytes -= record.bytes
      record.responses.length = 0
      record.bytes = 0
      record.replayable = false
    }
    output.write(line)
  }
  const unsubscribe = controller.subscribe((_view, event) => {
    if (!event || !subscribed) return
    if (bufferedEvents) {
      bufferedEvents.push(event)
      return
    }
    write(eventResponse(event))
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
      let requestRecord: RequestRecord | undefined
      try {
        const request = parseRequest(line)
        const digest = canonicalDigest(request)
        const previous = requests.get(request.requestId)
        if (previous) {
          if (previous.digest !== digest) {
            write(
              errorResponse(
                new RpcParseError(
                  'REQUEST_ID_CONFLICT',
                  `requestId ${request.requestId} was already used with different input`,
                ),
                request.requestId,
              ),
            )
          } else if (!previous.replayable) {
            write(
              errorResponse(
                new RpcParseError(
                  'REQUEST_REPLAY_UNAVAILABLE',
                  `The cached response for requestId ${request.requestId} exceeded the replay limit`,
                ),
                request.requestId,
              ),
            )
          } else {
            for (const response of previous.responses) output.write(response)
          }
          continue
        }
        requestRecord = { digest, responses: [], bytes: 0, replayable: true }
        requests.set(request.requestId, requestRecord)
        trimReplayHistory()
        const respond = (response: BraidResponse) => {
          if (requestRecord) rememberResponse(requestRecord, response)
          else write(response)
        }
        if (!initialized && request.command !== 'initialize') {
          throw new RpcParseError('INITIALIZE_REQUIRED', 'The first command must be initialize')
        }
        if (request.command === 'send') await Promise.all(pendingCompletions)

        switch (request.command) {
          case 'initialize': {
            subscribed = request.params.subscribe ?? false
            bufferedEvents = subscribed ? [] : undefined
            const result = await controller.initialize(request.params.workspace)
            if (result.kind !== 'accepted') {
              bufferedEvents = undefined
              respond(errorResponse(result, request.requestId))
              break
            }
            initialized = true
            respond({
              version: BRAID_PROTOCOL_VERSION,
              type: 'ack',
              requestId: request.requestId,
              revision: result.revision,
              command: request.command,
            })
            for (const event of bufferedEvents ?? []) respond(eventResponse(event))
            bufferedEvents = undefined
            respond(stateResponse(controller, request.requestId))
            break
          }
          case 'get_state':
            respond(
              stateResponse(controller, request.requestId, request.params?.projection ?? 'full'),
            )
            break
          case 'subscribe': {
            subscribed = true
            respond({
              version: BRAID_PROTOCOL_VERSION,
              type: 'ack',
              requestId: request.requestId,
              revision: controller.view().revision,
              command: request.command,
            })
            break
          }
          case 'unsubscribe': {
            subscribed = false
            respond({
              version: BRAID_PROTOCOL_VERSION,
              type: 'ack',
              requestId: request.requestId,
              revision: controller.view().revision,
              command: request.command,
            })
            break
          }
          case 'send': {
            bufferedEvents = []
            const result = await controller.dispatch({
              type: 'send',
              operationId: request.operationId,
              text: request.params.text,
              ...(request.params.conversationId
                ? { conversationId: request.params.conversationId }
                : {}),
              ...(request.params.branchId ? { branchId: request.params.branchId } : {}),
            })
            if (result.kind !== 'accepted') {
              bufferedEvents = undefined
              respond(errorResponse(result, request.requestId))
              break
            }
            respond({
              version: BRAID_PROTOCOL_VERSION,
              type: 'ack',
              requestId: request.requestId,
              operationId: request.operationId,
              revision: result.revision,
              ...(result.replayed === undefined ? {} : { replayed: result.replayed }),
              command: request.command,
            })
            for (const event of bufferedEvents) respond(eventResponse(event))
            bufferedEvents = undefined
            if (result.completion) {
              let tracked: Promise<void>
              tracked = result.completion.finally(() => pendingCompletions.delete(tracked))
              pendingCompletions.add(tracked)
              void tracked.then(() => respond(stateResponse(controller, request.requestId)))
            } else {
              respond(stateResponse(controller, request.requestId))
            }
            break
          }
          case 'shutdown': {
            const result = await controller.dispatch({
              type: 'shutdown',
              operationId: request.operationId,
            })
            if (result.kind !== 'accepted') {
              respond(errorResponse(result, request.requestId))
              break
            }
            respond({
              version: BRAID_PROTOCOL_VERSION,
              type: 'ack',
              requestId: request.requestId,
              revision: result.revision,
              operationId: request.operationId,
              command: request.command,
            })
            if (result.completion) await result.completion
            await Promise.all(pendingCompletions)
            return 0
          }
          default: {
            const generic = request
            if (generic.command === 'cancel_run') bufferedEvents = []
            const result = await controller.dispatch({
              type: 'headless-command',
              command: generic.command,
              ...(generic.operationId ? { operationId: generic.operationId } : {}),
              params: generic.params,
            })
            if (result.kind !== 'accepted') {
              respond(errorResponse(result, request.requestId))
              break
            }
            respond({
              version: BRAID_PROTOCOL_VERSION,
              type: 'ack',
              requestId: request.requestId,
              revision: result.revision,
              ...(generic.operationId ? { operationId: generic.operationId } : {}),
              command: generic.command,
            })
            if (generic.command === 'cancel_run') {
              for (const event of bufferedEvents ?? []) respond(eventResponse(event))
              bufferedEvents = undefined
              if (result.completion) await result.completion
              respond(stateResponse(controller, request.requestId))
            }
            if (
              generic.command === 'get_graph' ||
              generic.command === 'get_activity' ||
              generic.command === 'get_details'
            ) {
              respond(stateResponse(controller, request.requestId))
            }
            break
          }
        }
      } catch (error) {
        bufferedEvents = undefined
        const response = errorResponse(error, requestId)
        if (requestRecord) rememberResponse(requestRecord, response)
        else write(response)
      }
    }
    const eofShutdown = await controller.dispatch({
      type: 'shutdown',
      operationId: 'rpc-eof-shutdown',
    })
    if (eofShutdown.kind === 'accepted' && eofShutdown.completion) await eofShutdown.completion
    await Promise.all(pendingCompletions)
    return 0
  } finally {
    unsubscribe()
  }
}
