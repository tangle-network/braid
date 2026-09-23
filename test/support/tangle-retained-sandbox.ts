import type {
  AgentExactRunControlRef,
  AgentProfile,
  AgentRunCancellationAcknowledgement,
  AgentRunCancellationRequest,
  InteractionResponseCommand,
  RequestedInteractions,
} from '@tangle-network/agent-interface'
import {
  createTangleProvider,
  defaultTangleSandboxCapabilities,
  type SandboxClientLike,
  type SandboxInstanceLike,
} from '@tangle-network/agent-provider-tangle'
import type { CreateSandboxOptions, SandboxEvent } from '@tangle-network/sandbox'
import { safeExecutionId } from '../../src/adapters/runtime/production-backend-common.js'
import type { PreparedTangleRetainedConnection } from '../../src/adapters/runtime/production-tangle-sandbox-backend.js'
import { observeSandboxClient } from '../../src/adapters/runtime/sandbox-observation.js'
import {
  retainedSandboxIdentity,
  retainedSandboxLifecycle,
  withRetainedSandboxPolicy,
} from '../../src/adapters/runtime/tangle-sandbox-retention.js'

interface FakeExecution {
  readonly sessionId: string
  readonly executionId: string
  readonly controlRef: AgentExactRunControlRef
  readonly events: SandboxEvent[]
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  text: string
  error?: string
  readonly waiters: Set<() => void>
}

export interface FakeRetainedBox {
  readonly id: string
  readonly idempotencyKey: string
  readonly name?: string
  readonly metadata?: Record<string, unknown>
  deleted: boolean
}

/** Stateful double for the exact Tangle SDK surface used by provider 0.13.0. */
export class FakeTangleRetainedSandbox {
  readonly createCalls: CreateSandboxOptions[] = []
  readonly dispatches: Array<{
    readonly boxId: string
    readonly sessionId: string
    readonly executionId: string
    readonly prompt: string
    readonly interactions?: RequestedInteractions
  }> = []
  readonly cancellations: AgentRunCancellationRequest[] = []
  failDispatch = false
  failDelete = false
  providerRunId?: string

  readonly #boxesByKey = new Map<string, FakeRetainedBox>()
  readonly #boxesById = new Map<string, FakeRetainedBox>()
  readonly #executions = new Map<string, FakeExecution>()
  readonly #cancellationDigests = new Map<string, string>()

  get boxes(): readonly FakeRetainedBox[] {
    return [...this.#boxesById.values()].filter((box) => !box.deleted)
  }

  client(): SandboxClientLike {
    return {
      async fetch() {
        throw new Error('The lazy capability probe must not call the Sandbox transport')
      },
      create: async (options) => {
        const create = structuredClone(options ?? {})
        this.createCalls.push(create)
        const key = create.idempotencyKey
        if (typeof key !== 'string' || key.length === 0) {
          throw new Error('Fake Tangle create requires idempotencyKey')
        }
        const existing = this.#boxesByKey.get(key)
        const box = existing ?? this.#createBox(key, create)
        return this.#instance(box)
      },
      get: async (id) => {
        const box = this.#boxesById.get(id)
        return box === undefined || box.deleted ? null : this.#instance(box)
      },
      list: async () => this.boxes.map((box) => this.#instance(box)),
      listBackends: async () => ({
        backends: [
          {
            type: 'opencode',
            name: 'OpenCode',
            description: 'Fake retained OpenCode backend',
            capabilities: {
              streaming: true,
              toolUse: true,
              reasoning: true,
              multimodal: false,
              imageInput: false,
              contextWindow: 128_000,
              mcp: true,
              sessions: true,
              configurable: true,
              interactions: ['permission', 'question', 'plan'],
            },
          },
        ],
        timestamp: new Date(0).toISOString(),
      }),
      describePlacement: () => ({
        kind: 'sandbox',
        machineId: 'machine-fake-retained',
        region: 'test-region',
      }),
    }
  }

  complete(executionId: string, text: string): void {
    this.#settle(executionId, 'completed', text)
  }

  controlRefForExecution(executionId: string): AgentExactRunControlRef | null {
    const exact = this.#executions.get(executionId)?.controlRef
    return exact === undefined ? null : structuredClone(exact)
  }

  #createBox(key: string, options: CreateSandboxOptions): FakeRetainedBox {
    const box: FakeRetainedBox = {
      id: `sandbox-${key}`,
      idempotencyKey: key,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.metadata === undefined ? {} : { metadata: structuredClone(options.metadata) }),
      deleted: false,
    }
    this.#boxesByKey.set(key, box)
    this.#boxesById.set(box.id, box)
    return box
  }

  #instance(box: FakeRetainedBox): SandboxInstanceLike {
    const sandbox = this
    return {
      id: box.id,
      ...(box.name === undefined ? {} : { name: box.name }),
      ...(box.metadata === undefined ? {} : { metadata: box.metadata }),
      status: box.deleted ? 'stopped' : 'running',
      async capabilities() {
        return {
          schema: 1,
          dispatch: { runControlRef: true, executionIdOnAdmission: true },
          cancel: { canonicalRunCancellation: true, digestBound: true, idempotent: true },
          runs: { executionScopedStatus: true, eventReplay: true },
          interactions: { responseDedupe: true },
        }
      },
      async refresh() {},
      async delete() {
        if (sandbox.failDelete) throw new Error('Injected Tangle delete failure')
        box.deleted = true
      },
      async dispatchPrompt(message, options) {
        if (sandbox.failDispatch) throw new Error('Injected Tangle dispatch failure')
        const sessionId = options?.sessionId
        const executionId = options?.executionId
        const controlRef = options?.runControlRef
        if (
          typeof sessionId !== 'string' ||
          typeof executionId !== 'string' ||
          controlRef === undefined
        ) {
          throw new Error('Fake Tangle dispatch requires exact control coordinates')
        }
        const exactControlRef =
          sandbox.providerRunId === undefined
            ? controlRef
            : Object.freeze({ ...controlRef, runId: sandbox.providerRunId })
        const existing = sandbox.#executions.get(executionId)
        if (existing !== undefined) {
          return {
            sessionId,
            executionId,
            dispatched: false,
            alreadyExisted: true,
            runControlRef: existing.controlRef,
          }
        }
        const execution: FakeExecution = {
          sessionId,
          executionId,
          controlRef: exactControlRef,
          events: [
            sandbox.#event(executionId, sessionId, 1, 'started'),
            sandbox.#event(executionId, sessionId, 2, 'processing'),
          ],
          status: 'running',
          text: '',
          waiters: new Set(),
        }
        sandbox.#executions.set(executionId, execution)
        sandbox.dispatches.push({
          boxId: box.id,
          sessionId,
          executionId,
          prompt: typeof message === 'string' ? message : JSON.stringify(message),
          ...(options?.backend?.interactions === undefined
            ? {}
            : { interactions: structuredClone(options.backend.interactions) }),
        })
        return {
          sessionId,
          executionId,
          dispatched: true,
          alreadyExisted: false,
          status: 'running',
          runControlRef: exactControlRef,
        }
      },
      async *streamPrompt(_message, options) {
        const executionId = options?.executionId
        if (typeof executionId !== 'string') return
        const execution = sandbox.#requireExecution(executionId)
        let index = 0
        if (options?.lastEventId && options.lastEventId !== '0') {
          const cursorIndex = execution.events.findIndex(
            (event) => event.id === options.lastEventId,
          )
          if (cursorIndex < 0) throw new Error('Fake Tangle cursor does not exist')
          index = cursorIndex + 1
        }
        while (true) {
          options?.signal?.throwIfAborted()
          while (index < execution.events.length) {
            const event = execution.events[index]
            index += 1
            if (event !== undefined) yield event
          }
          if (execution.status !== 'running') return
          await sandbox.#wait(execution, options?.signal)
        }
      },
      session(sessionId) {
        return {
          id: sessionId,
          async status() {
            const execution = [...sandbox.#executions.values()]
              .filter((candidate) => candidate.sessionId === sessionId)
              .at(-1)
            return {
              status: execution?.status ?? 'running',
              ...(execution === undefined
                ? {}
                : {
                    activeExecutionId:
                      execution.status === 'running' ? execution.executionId : undefined,
                    latestExecutionId: execution.executionId,
                    runControlRef: execution.controlRef,
                  }),
            }
          },
          async *events() {},
          async result(options) {
            const executionId = options?.executionId
            if (typeof executionId !== 'string') {
              throw new Error('Fake Tangle result requires executionId')
            }
            const execution = sandbox.#requireExecution(executionId)
            while (execution.status === 'running') {
              await sandbox.#wait(execution, options?.signal)
            }
            const success = execution.status === 'completed'
            return {
              executionId,
              success,
              status: success ? 'success' : 'failed',
              durationMs: 5,
              response: execution.text,
              ...(execution.error === undefined ? {} : { error: execution.error }),
            }
          },
          async prompt() {
            throw new Error('Fake Tangle prompt is not used by retained dispatch')
          },
          async respondToInteraction(command: InteractionResponseCommand) {
            return {
              acknowledgement: {
                operationId: command.operationId,
                binding: command.binding,
                commandDigest: command.commandDigest,
                status: 'accepted',
              },
            }
          },
          async interrupt(options) {
            const executionId = options?.executionId
            if (typeof executionId !== 'string') return { cancelled: false }
            const execution = sandbox.#executions.get(executionId)
            if (execution === undefined || execution.status !== 'running') {
              return { cancelled: false }
            }
            sandbox.#settle(executionId, 'cancelled', '')
            return { cancelled: true }
          },
          async cancelRun(
            request: AgentRunCancellationRequest,
          ): Promise<AgentRunCancellationAcknowledgement> {
            const prior = sandbox.#cancellationDigests.get(request.operationId)
            if (prior !== undefined && prior !== request.requestDigest) {
              return { ...request, status: 'conflict', effect: 'unknown' }
            }
            sandbox.#cancellationDigests.set(request.operationId, request.requestDigest)
            sandbox.cancellations.push(structuredClone(request))
            const execution = sandbox.#requireExecution(request.run.executionId)
            if (execution.status === 'running') {
              sandbox.#settle(execution.executionId, 'cancelled', '')
            }
            return {
              operationId: request.operationId,
              requestDigest: request.requestDigest,
              run: request.run,
              status: prior === undefined ? 'accepted' : 'replayed',
              effect: 'cancelled',
            }
          },
        }
      },
    }
  }

  #event(
    executionId: string,
    sessionId: string,
    sequence: number,
    status: 'started' | 'processing',
  ): SandboxEvent {
    return {
      type: 'status',
      id: `event-${executionId}-${sequence}`,
      data: { executionId, sessionId, status, normalized: { type: 'status', status } },
    } as SandboxEvent
  }

  #settle(executionId: string, status: FakeExecution['status'], text: string): void {
    const execution = this.#requireExecution(executionId)
    execution.status = status
    execution.text = text
    for (const waiter of execution.waiters) waiter()
    execution.waiters.clear()
  }

  #requireExecution(executionId: string): FakeExecution {
    const execution = this.#executions.get(executionId)
    if (execution === undefined) throw new Error(`Unknown fake execution ${executionId}`)
    return execution
  }

  async #wait(execution: FakeExecution, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        execution.waiters.delete(finish)
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      execution.waiters.add(finish)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

/** Test-only provider proof. Production must obtain these claims from the published provider. */
export async function prepareFakeTangleRetainedConnection(input: {
  readonly sandbox: FakeTangleRetainedSandbox
  readonly profile: Readonly<AgentProfile>
  readonly runId: string
  readonly providerSessionId?: string
  readonly idleTtlSeconds?: number
}): Promise<PreparedTangleRetainedConnection> {
  const runner = 'opencode' as const
  const model = input.profile.model?.default
  if (typeof model !== 'string') throw new Error('Fake retained connection requires one model')
  const providerSessionId =
    input.providerSessionId ?? `session-braid-${safeExecutionId(input.runId)}`
  const identity = retainedSandboxIdentity(providerSessionId)
  const idleTtlSeconds = input.idleTtlSeconds ?? 1_800
  const base = defaultTangleSandboxCapabilities(runner)
  const declared = {
    ...base,
    sessions: { ...base.sessions, continue: true },
    retainedControl: {
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    },
  }
  const lifecycle = retainedSandboxLifecycle(idleTtlSeconds)
  const observed = observeSandboxClient(
    withRetainedSandboxPolicy(input.sandbox.client(), idleTtlSeconds),
    lifecycle,
  )
  const provider = createTangleProvider({
    client: observed.client,
    defaultBackend: runner,
    name: 'tangle-sandbox',
    capabilities: declared,
  })
  const capabilities = await provider.capabilities()
  return Object.freeze({
    profile: input.profile,
    model,
    runner,
    provider,
    capabilities,
    observation: observed.observation,
    providerSessionId,
    environmentIdempotencyKey: identity.environmentIdempotencyKey,
    environmentName: identity.name,
    environmentMetadata: identity.metadata,
    idleTtlSeconds,
    discoverControlRef: async (braidRunId: string) =>
      input.sandbox.controlRefForExecution(safeExecutionId(braidRunId)),
    materializationReceipt: Object.freeze({
      provider: 'tangle-sandbox',
      backend: 'environment-provider',
      lifecycle: 'retained',
      cleanup: 'explicit',
      continuity: 'session',
      portableContext: 'unavailable',
      model,
      runner,
    }),
  })
}
