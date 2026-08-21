import { boundedDrain } from '../../app/application-lifecycle.js'
import { canonicalRequestIdentity } from '../shared/canonical.js'
import type { BraidUiController, UiEvent } from '../shared/intents.js'
import { redactSensitiveText, sanitizeTerminalText } from '../shared/sanitize.js'
import { BoundedOutputQueue } from './bounded-output.js'
import {
  BRAID_PROTOCOL_VERSION,
  type BraidResponse,
  type ErrorResponse,
  type GenericRpcRequest,
  type StateProjection,
} from './protocol.js'
import { linesOf, parseRequest, RpcParseError, requestIdOf } from './rpc-parser.js'
import {
  type RequestRecord,
  RPC_REPLAY_MAX_BYTES,
  RPC_REPLAY_MAX_ENTRIES,
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
        queue: view.queue ?? [],
        queueCount: view.queueCount,
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
  const outputQueue = new BoundedOutputQueue(output)
  let outputFailure: unknown
  let shutdownStarted = false
  let applicationClosed = false
  let closePromise: Promise<void> | undefined
  const writeRaw = async (line: string): Promise<void> => {
    if (outputFailure !== undefined) throw outputFailure
    try {
      await outputQueue.write(line)
    } catch (error) {
      outputFailure ??= error
      throw error
    }
  }
  const write = (response: BraidResponse): Promise<void> =>
    writeRaw(`${JSON.stringify(response)}\n`)
  const emit = async (response: BraidResponse): Promise<void> => {
    if (outputFailure !== undefined) throw outputFailure
    await write(response)
  }
  const requestShutdown = async (): Promise<void> => {
    if (shutdownStarted) return
    shutdownStarted = true
    const result = await controller.dispatch({
      type: 'shutdown',
      operationId: 'op-rpc-eof-shutdown',
      mode: 'cancel',
    })
    if (result.kind === 'accepted' && result.completion) await result.completion
  }
  const closeApplication = async (): Promise<void> => {
    closePromise ??= controller.close?.() ?? boundedDrain(pendingCompletions).then(() => undefined)
    await closePromise
    applicationClosed = true
  }
  const trimReplayHistory = () => {
    while (requests.size > RPC_REPLAY_MAX_ENTRIES || replayBytes > RPC_REPLAY_MAX_BYTES) {
      const oldest = requests.entries().next().value as [string, RequestRecord] | undefined
      if (!oldest) break
      requests.delete(oldest[0])
      replayBytes -= oldest[1].bytes
    }
  }
  const rememberResponse = async (
    record: RequestRecord,
    response: BraidResponse,
  ): Promise<void> => {
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
    await writeRaw(line)
  }
  const unsubscribe = controller.subscribe((_view, event) => {
    if (!event || !subscribed) return
    if (bufferedEvents) {
      bufferedEvents.push(event)
      return
    }
    void emit(eventResponse(event)).catch(() => undefined)
  })

  try {
    for await (const line of linesOf(input)) {
      if (outputFailure !== undefined) throw outputFailure
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
        const identity = canonicalRequestIdentity(request)
        const previous = requests.get(request.requestId)
        if (previous) {
          if (previous.identity !== identity) {
            await write(
              errorResponse(
                new RpcParseError(
                  'REQUEST_ID_CONFLICT',
                  `requestId ${request.requestId} was already used with different input`,
                ),
                request.requestId,
              ),
            )
          } else if (!previous.replayable) {
            await write(
              errorResponse(
                new RpcParseError(
                  'REQUEST_REPLAY_UNAVAILABLE',
                  `The cached response for requestId ${request.requestId} exceeded the replay limit`,
                ),
                request.requestId,
              ),
            )
          } else {
            for (const response of previous.responses) await writeRaw(response)
          }
          continue
        }
        requestRecord = { identity, responses: [], bytes: 0, replayable: true }
        requests.set(request.requestId, requestRecord)
        trimReplayHistory()
        const respond = async (response: BraidResponse): Promise<void> => {
          if (requestRecord) await rememberResponse(requestRecord, response)
          else await write(response)
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
              await respond(errorResponse(result, request.requestId))
              break
            }
            initialized = true
            await respond({
              version: BRAID_PROTOCOL_VERSION,
              type: 'ack',
              requestId: request.requestId,
              revision: result.revision,
              command: request.command,
            })
            for (const event of bufferedEvents ?? []) await respond(eventResponse(event))
            bufferedEvents = undefined
            await respond(stateResponse(controller, request.requestId))
            break
          }
          case 'get_state':
            await respond(
              stateResponse(controller, request.requestId, request.params?.projection ?? 'full'),
            )
            break
          case 'subscribe': {
            subscribed = true
            await respond({
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
            await respond({
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
              await respond(errorResponse(result, request.requestId))
              break
            }
            const admissionState = result.completion
              ? stateResponse(controller, request.requestId)
              : undefined
            await respond({
              version: BRAID_PROTOCOL_VERSION,
              type: 'ack',
              requestId: request.requestId,
              operationId: request.operationId,
              revision: result.revision,
              ...(result.replayed === undefined ? {} : { replayed: result.replayed }),
              ...(result.runId === undefined ? {} : { runId: result.runId }),
              ...(result.admission === undefined ? {} : { admission: result.admission }),
              ...(result.data === undefined ? {} : { result: result.data }),
              command: request.command,
            })
            for (const event of bufferedEvents) await respond(eventResponse(event))
            bufferedEvents = undefined
            if (admissionState) await respond(admissionState)
            if (result.completion) {
              let tracked: Promise<void>
              tracked = result.completion.finally(() => pendingCompletions.delete(tracked))
              pendingCompletions.add(tracked)
              void tracked
                .then(() => {
                  if (applicationClosed) return
                  return respond(stateResponse(controller, request.requestId))
                })
                .catch(() => undefined)
            } else {
              await respond(stateResponse(controller, request.requestId))
            }
            break
          }
          case 'shutdown': {
            shutdownStarted = true
            const result = await controller.dispatch({
              type: 'shutdown',
              operationId: request.operationId,
              ...(request.params?.mode === undefined ? {} : { mode: request.params.mode }),
            })
            if (result.kind !== 'accepted') {
              await respond(errorResponse(result, request.requestId))
              break
            }
            await respond({
              version: BRAID_PROTOCOL_VERSION,
              type: 'ack',
              requestId: request.requestId,
              revision: result.revision,
              operationId: request.operationId,
              command: request.command,
            })
            if (result.completion) await result.completion
            await closeApplication()
            await outputQueue.flush()
            if (outputFailure !== undefined) throw outputFailure
            return 0
          }
          default: {
            const generic = request as GenericRpcRequest
            if (generic.command === 'cancel_run') bufferedEvents = []
            const result = await controller.dispatch({
              type: 'headless-command',
              command: generic.command,
              ...(generic.operationId ? { operationId: generic.operationId } : {}),
              params: generic.params,
            })
            if (result.kind !== 'accepted') {
              await respond(errorResponse(result, request.requestId))
              break
            }
            await respond({
              version: BRAID_PROTOCOL_VERSION,
              type: 'ack',
              requestId: request.requestId,
              revision: result.revision,
              ...(generic.operationId ? { operationId: generic.operationId } : {}),
              command: generic.command,
              ...(result.runId === undefined ? {} : { runId: result.runId }),
              ...(result.control === undefined ? {} : { control: result.control }),
              ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
              ...(result.position === undefined ? {} : { position: result.position }),
              ...(result.replayed === undefined ? {} : { replayed: result.replayed }),
              ...(result.admission === undefined ? {} : { admission: result.admission }),
              ...(result.data === undefined ? {} : { result: result.data }),
            })
            if (generic.command === 'cancel_run') {
              for (const event of bufferedEvents ?? []) await respond(eventResponse(event))
              bufferedEvents = undefined
              if (result.completion) await result.completion
              await respond(stateResponse(controller, request.requestId))
            }
            break
          }
        }
      } catch (error) {
        bufferedEvents = undefined
        const response = errorResponse(error, requestId)
        if (requestRecord) await rememberResponse(requestRecord, response)
        else await write(response)
      }
    }
    await requestShutdown()
    await closeApplication()
    await outputQueue.flush()
    if (outputFailure !== undefined) throw outputFailure
    return 0
  } finally {
    try {
      await requestShutdown()
      await closeApplication()
    } catch {
      // The outer application close barrier records any unresolved run state.
    }
    unsubscribe()
  }
}
