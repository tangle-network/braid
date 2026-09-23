import { AppError, type BraidApplication } from '../../app/application.js'
import { MAX_OUTPUT_QUEUE, MAX_OUTPUT_QUEUE_BYTES, utf8Bytes } from '../../domain/bounds.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { BraidEventEnvelope } from '../../domain/events.js'
import { BRAID_PROTOCOL_VERSION, type BraidResponse } from './protocol.js'
import { parseRpcRequest, requestIdOf } from './rpc-request.js'
import { linesOf, type RpcInput } from './rpc-lines.js'
import { RpcReplayStore } from './rpc-replay.js'
import { errorResponse } from './rpc-error.js'
import { RpcEventBuffer } from './rpc-event-buffer.js'

export type { RpcInput } from './rpc-lines.js'

export interface RpcOutput {
  write(chunk: string): boolean
  waitForDrain?: () => Promise<void>
}

export { RPC_REPLAY_MAX_BYTES, RPC_REPLAY_MAX_ENTRIES } from './rpc-replay.js'

export class OutputQueue {
  readonly #output: RpcOutput
  readonly #queue: string[] = []
  #queuedBytes = 0
  #running: Promise<void> | undefined
  #failure: Error | undefined

  constructor(output: RpcOutput) {
    this.#output = output
  }

  enqueue(line: string): void {
    this.#throwIfFailed()
    const lineBytes = utf8Bytes(line)
    if (
      this.#queue.length >= MAX_OUTPUT_QUEUE ||
      lineBytes > MAX_OUTPUT_QUEUE_BYTES ||
      this.#queuedBytes + lineBytes > MAX_OUTPUT_QUEUE_BYTES
    ) {
      throw new AppError('OUTPUT_BACKPRESSURE', 'Output queue is full')
    }
    this.#queue.push(line)
    this.#queuedBytes += lineBytes
    if (!this.#running) {
      this.#running = this.#pump().finally(() => {
        this.#running = undefined
      })
    }
  }

  async flush(): Promise<void> {
    if (this.#running) await this.#running
    this.#throwIfFailed()
  }

  #throwIfFailed(): void {
    if (this.#failure) throw this.#failure
  }

  async #pump(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        const line = this.#queue.shift()
        if (line === undefined) continue
        this.#queuedBytes -= utf8Bytes(line)
        if (this.#output.write(line)) continue
        if (!this.#output.waitForDrain) {
          throw new AppError(
            'OUTPUT_BACKPRESSURE',
            'Output is not ready and exposes no drain signal',
          )
        }
        await this.#output.waitForDrain()
      }
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error))
      this.#queue.length = 0
      this.#queuedBytes = 0
    }
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
  const bufferedEvents = new RpcEventBuffer()
  const replay = new RpcReplayStore()
  const writer = new OutputQueue(output)
  const write = (response: BraidResponse) => writer.enqueue(`${JSON.stringify(response)}\n`)
  const unsubscribe = app.subscribe((_state, envelope) => {
    if (!subscribed) return
    if (bufferedEvents.active) bufferedEvents.add(envelope)
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
            replay.replay(previous, (response) => writer.enqueue(response))
          }
          await writer.flush()
          continue
        }
        requestRecord = replay.add(request.requestId, digest)
        const respond = (response: BraidResponse) => {
          if (requestRecord)
            replay.remember(requestRecord, response, (line) => writer.enqueue(line))
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
            bufferedEvents.begin()
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
            for (const envelope of bufferedEvents.take()) write(eventResponse(envelope))
            const state = await receipt.completion
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: state.revision,
              state,
            })
            await writer.flush()
            break
          }
          case 'respond_interaction':
          case 'cancel_interaction': {
            bufferedEvents.begin()
            const interactionInput = {
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
              ...(request.params.conversationId === undefined
                ? {}
                : { conversationId: request.params.conversationId }),
              ...(request.params.branchId === undefined
                ? {}
                : { branchId: request.params.branchId }),
              ...(request.params.model === undefined ? {} : { model: request.params.model }),
              ...(request.params.runner === undefined ? {} : { runner: request.params.runner }),
              ...(request.params.requestRevision === undefined
                ? {}
                : { requestRevision: request.params.requestRevision }),
              operationId: request.operationId,
            }
            const result =
              request.command === 'respond_interaction'
                ? await app.respondInteraction({
                    ...interactionInput,
                    response: request.params.response,
                  })
                : await app.cancelInteraction(interactionInput)
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
            for (const envelope of bufferedEvents.take()) write(eventResponse(envelope))
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: state.revision,
              state: app.state(),
            })
            await writer.flush()
            break
          }
          case 'automation_create': {
            bufferedEvents.begin()
            const rule = app.createAutomationRule({
              operationId: request.operationId,
              ...(request.params.interactionKey === undefined
                ? {}
                : { interactionKey: request.params.interactionKey }),
              ...(request.params.request === undefined ? {} : { request: request.params.request }),
              ...(request.params.matcher === undefined ? {} : { matcher: request.params.matcher }),
              answer: request.params.answer,
              responseScope: request.params.responseScope,
              ...(request.params.expiresAt === undefined
                ? {}
                : { expiresAt: request.params.expiresAt }),
              ...(request.params.maximumUses === undefined
                ? {}
                : { maximumUses: request.params.maximumUses }),
              ...(request.params.priority === undefined
                ? {}
                : { priority: request.params.priority }),
            })
            await app.waitForAutomation()
            const state = app.state()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              operationId: request.operationId,
              replayed: false,
              revision: state.revision,
              automation: { rule },
            })
            for (const envelope of bufferedEvents.take()) write(eventResponse(envelope))
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: app.state().revision,
              state: app.state(),
            })
            await writer.flush()
            break
          }
          case 'automation_dry_run': {
            bufferedEvents.begin()
            const result = await app.dryRunAutomation({
              operationId: request.operationId,
              key: request.params.key,
            })
            const state = app.state()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              operationId: request.operationId,
              replayed: result.replayed,
              revision: state.revision,
              automation: { result },
            })
            for (const envelope of bufferedEvents.take()) write(eventResponse(envelope))
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: app.state().revision,
              state: app.state(),
            })
            await writer.flush()
            break
          }
          case 'automation_update': {
            bufferedEvents.begin()
            const rule = app.updateAutomationRule({
              operationId: request.operationId,
              ruleId: request.params.ruleId,
              ...(request.params.interactionKey === undefined
                ? {}
                : { interactionKey: request.params.interactionKey }),
              ...(request.params.request === undefined ? {} : { request: request.params.request }),
              ...(request.params.matcher === undefined ? {} : { matcher: request.params.matcher }),
              ...(request.params.answer === undefined ? {} : { answer: request.params.answer }),
              ...(request.params.responseScope === undefined
                ? {}
                : { responseScope: request.params.responseScope }),
              ...(request.params.expiresAt === undefined
                ? {}
                : { expiresAt: request.params.expiresAt }),
              ...(request.params.maximumUses === undefined
                ? {}
                : { maximumUses: request.params.maximumUses }),
              ...(request.params.priority === undefined
                ? {}
                : { priority: request.params.priority }),
            })
            await app.waitForAutomation()
            const state = app.state()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              operationId: request.operationId,
              replayed: false,
              revision: state.revision,
              automation: { rule },
            })
            for (const envelope of bufferedEvents.take()) write(eventResponse(envelope))
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: app.state().revision,
              state: app.state(),
            })
            await writer.flush()
            break
          }
          case 'automation_disable':
          case 'automation_delete': {
            bufferedEvents.begin()
            const changed =
              request.command === 'automation_disable'
                ? app.disableAutomationRule(request.operationId, request.params.ruleId)
                : app.deleteAutomationRule(request.operationId, request.params.ruleId)
            const state = app.state()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              operationId: request.operationId,
              replayed: false,
              revision: state.revision,
              automation: { result: changed },
            })
            for (const envelope of bufferedEvents.take()) write(eventResponse(envelope))
            respond({
              version: 1,
              type: 'state',
              requestId: request.requestId,
              revision: app.state().revision,
              state: app.state(),
            })
            await writer.flush()
            break
          }
          case 'automation_list': {
            const state = app.state()
            respond({
              version: 1,
              type: 'ack',
              requestId: request.requestId,
              revision: state.revision,
              automation: { rules: state.rules },
            })
            await writer.flush()
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
            await writer.flush()
            return 0
          }
          default: {
            const exhaustive: never = request
            return exhaustive
          }
        }
      } catch (error) {
        bufferedEvents.clear()
        const response = errorResponse(error, requestId)
        if (requestRecord) replay.remember(requestRecord, response, (line) => writer.enqueue(line))
        else write(response)
        await writer.flush()
      }
    }
    await writer.flush()
    return 0
  } catch (error) {
    try {
      write(errorResponse(error))
      await writer.flush()
    } catch {
      return 2
    }
    return 2
  } finally {
    unsubscribe()
    app.shutdown()
  }
}
