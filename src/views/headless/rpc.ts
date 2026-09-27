import { boundedDrain } from '../../app/application-lifecycle.js'
import { canonicalRequestIdentity } from '../shared/canonical.js'
import type { BraidUiController, UiEvent } from '../shared/intents.js'
import { redactSensitiveText, sanitizeTerminalText } from '../shared/sanitize.js'
import { BoundedOutputQueue } from './bounded-output.js'
import {
  BRAID_PROTOCOL_VERSION,
  type BraidRequest,
  type BraidResponse,
  type ErrorResponse,
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
        ...(state.focusedRunId === undefined ? {} : { focusedRunId: state.focusedRunId }),
        ...(state.activeRuns === undefined ? {} : { activeRuns: state.activeRuns }),
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
  const pendingDispatches = new Set<Promise<void>>()
  // Leave capacity for approval/cancellation even when admission is saturated.
  const MAX_PENDING_DISPATCHES = 64
  const CONTROL_RESERVE = 16
  const sendAcks = new Map<string, number>()
  const eventBarriers = new Set<string>()
  let bufferedEventBytes = 0
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
    await boundedDrain(pendingDispatches)
    applicationClosed = true
  }
  const trackCompletion = (
    completion: Promise<unknown>,
    onFulfilled?: () => void | Promise<void>,
  ): void => {
    // Track run settlement, not response delivery: a replay's final projection may
    // wait for earlier sends without making its own acknowledgement a dependency.
    const tracked = completion.then(() => undefined)
    pendingCompletions.add(tracked)
    void tracked
      .then(() => onFulfilled?.())
      .then(
        () => pendingCompletions.delete(tracked),
        () => pendingCompletions.delete(tracked),
      )
  }

  const trimReplayHistory = () => {
    while (requests.size > RPC_REPLAY_MAX_ENTRIES || replayBytes > RPC_REPLAY_MAX_BYTES) {
      const oldest = [...requests.entries()].find(([, record]) => !record.pending)
      if (!oldest) break
      requests.delete(oldest[0])
      replayBytes -= oldest[1].bytes
      oldest[1].responses.length = 0
      oldest[1].bytes = 0
      oldest[1].replayable = false
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
      if (replayBytes > RPC_REPLAY_MAX_BYTES) {
        replayBytes -= record.bytes
        record.responses.length = 0
        record.bytes = 0
        record.replayable = false
      }
    } else if (record.replayable) {
      replayBytes -= record.bytes
      record.responses.length = 0
      record.bytes = 0
      record.replayable = false
    }
    await writeRaw(line)
  }
  const flushEvents = (): void => {
    if (eventBarriers.size > 0 || !initialized) return
    const events = bufferedEvents ?? []
    bufferedEvents = undefined
    bufferedEventBytes = 0
    for (const event of events) void emit(eventResponse(event)).catch(() => undefined)
  }
  const releaseSendAck = (operationId: string): void => {
    eventBarriers.delete(operationId)
    flushEvents()
  }
  const unsubscribe = controller.subscribe((_view, event) => {
    if (!event || !subscribed) return
    if (event.kind === 'run.requested') {
      const admission = event.payload.admission
      const operationId =
        admission && typeof admission === 'object' && 'operationId' in admission
          ? admission.operationId
          : undefined
      if (typeof operationId === 'string' && sendAcks.has(operationId)) {
        eventBarriers.add(operationId)
        bufferedEvents ??= []
      }
    }
    if (bufferedEvents) {
      bufferedEventBytes += Buffer.byteLength(JSON.stringify(event), 'utf8')
      if (bufferedEvents.length >= 4096 || bufferedEventBytes > RPC_REPLAY_MAX_BYTES) {
        outputFailure ??= new Error('OUTPUT_BACKPRESSURE_LIMIT: admission event buffer is full')
        return
      }
      bufferedEvents.push(event)
      return
    }
    void emit(eventResponse(event)).catch(() => undefined)
  })

  const handle = async (request: BraidRequest, record: RequestRecord): Promise<void> => {
    const respond = (response: BraidResponse) => rememberResponse(record, response)
    try {
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
          const priorDispatches = [...pendingDispatches]
          const priorCompletions = [...pendingCompletions]
          const intent = {
            type: 'send' as const,
            operationId: request.operationId,
            text: request.params.text,
            ...(request.params.conversationId !== undefined
              ? { conversationId: request.params.conversationId }
              : {}),
            ...(request.params.branchId !== undefined ? { branchId: request.params.branchId } : {}),
          }
          let result = await controller.dispatch(intent)
          if (
            result.kind === 'error' &&
            result.code === 'RUN_ACTIVE' &&
            priorCompletions.length > 0
          ) {
            // Preserve ordered JSONL follow-ups without blocking the input reader. The first
            // dispatch has already bound this operation's target before returning RUN_ACTIVE.
            await Promise.allSettled(priorCompletions)
            if (shutdownStarted || applicationClosed) return
            result = await controller.dispatch(intent)
          }
          if (result.kind !== 'accepted') {
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
          releaseSendAck(request.operationId)
          if (admissionState) await respond(admissionState)
          if (result.completion) {
            trackCompletion(result.completion, async () => {
              if (result.replayed) {
                await Promise.allSettled(priorDispatches)
                await Promise.allSettled(pendingCompletions)
              }
              if (applicationClosed) return
              return respond(stateResponse(controller, request.requestId))
            })
          } else {
            await respond(stateResponse(controller, request.requestId))
          }
          break
        }
        case 'shutdown': {
          if (request.params?.mode === undefined || request.params.mode === 'wait') {
            await Promise.allSettled(pendingDispatches)
            await Promise.allSettled(pendingCompletions)
          }
          const result = await controller.dispatch({
            type: 'shutdown',
            operationId: request.operationId,
            ...(request.params?.mode === undefined ? {} : { mode: request.params.mode }),
          })
          if (result.kind !== 'accepted') {
            await respond(errorResponse(result, request.requestId))
            break
          }
          shutdownStarted = true
          if (result.completion) await result.completion
          await closeApplication()
          await respond({
            version: BRAID_PROTOCOL_VERSION,
            type: 'ack',
            requestId: request.requestId,
            revision: result.revision,
            operationId: request.operationId,
            command: request.command,
          })
          await outputQueue.flush()
          if (outputFailure !== undefined) throw outputFailure
          return
        }
        default: {
          const generic = request
          const result = await controller.dispatch({
            type: 'headless-command',
            command: generic.command,
            ...(generic.operationId ? { operationId: generic.operationId } : {}),
            params: { ...generic.params },
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
          if (result.completion) {
            trackCompletion(result.completion, () => {
              if (applicationClosed) return
              return respond(stateResponse(controller, request.requestId))
            })
          }
          break
        }
      }
    } catch (error) {
      await respond(errorResponse(error, request.requestId))
    } finally {
      if (request.command === 'send') {
        const remaining = (sendAcks.get(request.operationId) ?? 1) - 1
        if (remaining === 0) sendAcks.delete(request.operationId)
        else sendAcks.set(request.operationId, remaining)
        releaseSendAck(request.operationId)
      }
    }
  }

  const launch = (record: RequestRecord, action: () => Promise<void>): Promise<void> => {
    record.pending = true
    const task = action().finally(() => {
      record.pending = false
      pendingDispatches.delete(task)
      trimReplayHistory()
    })
    record.dispatch = task
    pendingDispatches.add(task)
    void task.catch((error: unknown) => {
      outputFailure ??= error
    })
    return task
  }

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
      try {
        const request = parseRequest(line)
        if (!initialized && request.command !== 'initialize')
          throw new RpcParseError('INITIALIZE_REQUIRED', 'The first command must be initialize')
        const identity = canonicalRequestIdentity(request)
        const previous = requests.get(request.requestId)
        if (previous && previous.identity !== identity)
          throw new RpcParseError(
            'REQUEST_ID_CONFLICT',
            `requestId ${request.requestId} was already used with different input`,
          )
        const independent = isRunDispatch(request.command)
        const limit =
          MAX_PENDING_DISPATCHES + (isUrgentControl(request.command) ? CONTROL_RESERVE : 0)
        if (pendingDispatches.size >= limit)
          throw new RpcParseError(
            'REQUEST_LIMIT',
            'Too many pending requests; retry after a correlated acknowledgement',
          )
        if (previous) {
          const replay = async () => {
            await previous.dispatch
            if (!previous.replayable) {
              await write(
                errorResponse(
                  new RpcParseError(
                    'REQUEST_REPLAY_UNAVAILABLE',
                    `The cached response for requestId ${request.requestId} exceeded the replay limit`,
                  ),
                  request.requestId,
                ),
              )
              return
            }
            for (const response of [...previous.responses]) await writeRaw(response)
          }
          if (previous.pending) {
            // A retry is not a second effect and must not stop the reader either.
            const duplicate: RequestRecord = {
              identity,
              responses: [],
              bytes: 0,
              replayable: false,
            }
            launch(duplicate, replay)
          } else await replay()
          continue
        }
        const record: RequestRecord = {
          identity,
          responses: [],
          bytes: 0,
          replayable: true,
          pending: true,
        }
        requests.set(request.requestId, record)
        trimReplayHistory()
        if (request.command === 'send')
          sendAcks.set(request.operationId, (sendAcks.get(request.operationId) ?? 0) + 1)
        const task =
          request.command === 'shutdown'
            ? handle(request, record).finally(() => {
                record.pending = false
              })
            : launch(record, () => handle(request, record))
        if (independent) {
          // Give synchronous admission a turn, never wait on the provider or run lifetime.
          await Promise.race([task, new Promise<void>((resolve) => setTimeout(resolve, 0))])
        } else {
          await task
          if (request.command === 'shutdown' && applicationClosed) return 0
        }
      } catch (error) {
        await write(errorResponse(error, requestId))
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

function isUrgentControl(command: string): boolean {
  return (
    command === 'cancel' ||
    command === 'cancel_run' ||
    command === 'detach' ||
    command === 'respond_interaction' ||
    command === 'cancel_interaction' ||
    command === 'shutdown'
  )
}

function isRunDispatch(command: string): boolean {
  return (
    (isUrgentControl(command) && command !== 'shutdown') ||
    command === 'send' ||
    command === 'queue' ||
    command === 'steer' ||
    command === 'reconnect' ||
    command === 'reconcile'
  )
}
