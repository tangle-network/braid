import { AppError, type BraidApplication } from '../../app/application.js'
import { parseAnalysisCommand } from '../../analysis/commands.js'
import { sanitizeDiagnosticText } from '../../analysis/diagnostics.js'
import { AnalysisServiceError } from '../../analysis/service.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { BraidEventEnvelope } from '../../domain/events.js'
import type { BraidResponse, ErrorResponse } from './protocol.js'
import { linesOf, RpcOutputQueue, type RpcInput, type RpcOutput } from './jsonl.js'
import { parseRequest } from './request-parser.js'

export type { RpcInput, RpcOutput } from './jsonl.js'

export const RPC_REPLAY_MAX_ENTRIES = 256
export const RPC_REPLAY_MAX_BYTES = 8 * 1024 * 1024

interface RequestRecord {
  readonly digest: string
  readonly responses: string[]
  bytes: number
  replayable: boolean
}

function errorResponse(error: unknown, requestId?: string): ErrorResponse {
  if (error instanceof AppError || error instanceof AnalysisServiceError)
    return {
      version: 1,
      type: 'error',
      ...(requestId ? { requestId } : {}),
      code: error.code,
      message: sanitizeDiagnosticText(error.message),
      retryable: false,
    }
  return {
    version: 1,
    type: 'error',
    ...(requestId ? { requestId } : {}),
    code: 'INTERNAL_ERROR',
    message: 'Internal Braid error',
    retryable: false,
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
  let replayBytes = 0
  let exitCode = 0
  const requests = new Map<string, RequestRecord>()
  const writer = new RpcOutputQueue(output)
  const write = (response: BraidResponse): void => writer.enqueue(`${JSON.stringify(response)}\n`)
  const trimReplayHistory = (): void => {
    while (requests.size > RPC_REPLAY_MAX_ENTRIES || replayBytes > RPC_REPLAY_MAX_BYTES) {
      const oldest = requests.entries().next().value as [string, RequestRecord] | undefined
      if (!oldest) break
      requests.delete(oldest[0])
      replayBytes -= oldest[1].bytes
    }
  }
  const rememberResponse = (record: RequestRecord, response: BraidResponse): void => {
    const line = `${JSON.stringify(response)}\n`
    const bytes = Buffer.byteLength(line)
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
    writer.enqueue(line)
  }
  const unsubscribe = app.subscribe((_state, envelope) => {
    if (!subscribed) return
    if (bufferedEvents) bufferedEvents.push(envelope)
    else
      write({
        version: 1,
        type: 'event',
        sequence: envelope.sequence,
        revision: envelope.revision,
        event: envelope.event,
      })
  })

  try {
    for await (const line of linesOf(input)) {
      let requestId: string | undefined
      let requestRecord: RequestRecord | undefined
      try {
        const request = parseRequest(line)
        requestId = request.requestId
        const digest = canonicalDigest(request)
        const previous = requests.get(request.requestId)
        if (previous) {
          if (previous.digest !== digest)
            write(
              errorResponse(
                new AppError('REQUEST_ID_CONFLICT', 'requestId is bound to another request'),
                request.requestId,
              ),
            )
          else if (!previous.replayable)
            write(
              errorResponse(
                new AppError('REQUEST_REPLAY_UNAVAILABLE', 'The cached response is unavailable'),
                request.requestId,
              ),
            )
          else for (const response of previous.responses) writer.enqueue(response)
          await writer.flush()
          continue
        }
        requestRecord = { digest, responses: [], bytes: 0, replayable: true }
        requests.set(request.requestId, requestRecord)
        trimReplayHistory()
        const respond = (response: BraidResponse): void =>
          rememberResponse(requestRecord as RequestRecord, response)
        if (!initialized && request.command !== 'initialize')
          throw new AppError('INITIALIZE_REQUIRED', 'The first command must be initialize')

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
          case 'get_state':
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: app.state().revision,
              state: app.state(),
            })
            break
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
            for (const envelope of bufferedEvents)
              write({
                version: 1,
                type: 'event',
                sequence: envelope.sequence,
                revision: envelope.revision,
                event: envelope.event,
              })
            bufferedEvents = undefined
            const state = await receipt.completion
            if (state.runs.at(-1)?.status === 'failed' || state.runs.at(-1)?.status === 'aborted')
              exitCode = 1
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: state.revision,
              state,
            })
            break
          }
          case 'analysis': {
            const parsedCommand = parseAnalysisCommand(request.params.text)
            if (!parsedCommand)
              throw new AppError('UNKNOWN_COMMAND', 'Unknown analysis slash command')
            if (parsedCommand.status === 'invalid')
              throw new AppError('INVALID_COMMAND', parsedCommand.message)
            if (parsedCommand.command.command === 'compare')
              throw new AppError(
                'INVALID_COMMAND',
                'Use the compare RPC command for paired source inputs',
              )
            const result = await app.executeAnalysisCommand(
              parsedCommand.command,
              request.operationId,
            )
            respond({ version: 1, type: 'analysis', requestId: request.requestId, result })
            if ('status' in result && result.status !== 'complete') exitCode = 1
            break
          }
          case 'get_graph':
            respond({ version: 1, type: 'graph', requestId: request.requestId, graph: app.graph() })
            break
          case 'cancel_run':
            respond({
              version: 1,
              type: 'cancellation',
              requestId: request.requestId,
              result: app.cancelRun({ operationId: request.operationId, ...request.params }),
            })
            break
          case 'cancel_worker':
            respond({
              version: 1,
              type: 'cancellation',
              requestId: request.requestId,
              result: await app.cancelWorker({
                operationId: request.operationId,
                ...request.params,
              }),
            })
            break
          case 'get_supervisor':
            respond({
              version: 1,
              type: 'supervisor',
              requestId: request.requestId,
              snapshot: await app.supervisorSnapshot(request.params.supervisorId),
            })
            break
          case 'compare':
            respond({
              version: 1,
              type: 'comparison',
              requestId: request.requestId,
              result: await app.compare({ operationId: request.operationId, ...request.params }),
            })
            break
          case 'shutdown': {
            const state = await app.waitForIdle()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              revision: state.revision,
            })
            await writer.flush()
            return exitCode
          }
          default: {
            const exhaustive: never = request
            return exhaustive
          }
        }
      } catch (error) {
        exitCode = 1
        bufferedEvents = undefined
        const response = errorResponse(error, requestId)
        if (requestRecord) rememberResponse(requestRecord, response)
        else write(response)
      }
      await writer.flush()
    }
    return exitCode
  } catch (error) {
    exitCode = 1
    try {
      writer.enqueue(`${JSON.stringify(errorResponse(error))}\n`)
      await writer.flush()
    } catch {
      // The output transport is already unable to accept a bounded error.
    }
    return exitCode
  } finally {
    unsubscribe()
    try {
      await writer.flush()
    } catch {
      exitCode = 1
    }
  }
}
