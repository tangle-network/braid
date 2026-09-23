import type { AgentProfile } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { canonicalDigest } from '../domain/canonical.js'
import { containsControlCharacters, redactErrorMessage } from '../connection/redaction.js'
import type { BraidEvent, BraidEventEnvelope, TurnUsage } from '../domain/events.js'
import { reduceEvent } from '../domain/reducer.js'
import { initialState, type BraidState } from '../domain/state.js'
import { validateCanonicalProfile } from '../profile/profile-validation.js'
import type { Clock } from '../ports/clock.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import { MemoryJournal } from './journal.js'
import type { ApplicationAdmissionGate } from './admission-gate.js'

export type AppSubscriber = (state: BraidState, envelope: BraidEventEnvelope) => void

export interface SendInput {
  readonly operationId: string
  readonly text: string
  readonly conversationId?: string
  readonly branchId?: string
}

export interface SendReceipt {
  readonly operationId: string
  readonly runId: string
  readonly revision: number
  readonly replayed: boolean
  readonly completion: Promise<BraidState>
}

interface OperationRecord {
  readonly digest: string
  readonly runId: string
  completion: Promise<void>
}

export class AppError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }
}

function usageFromFinal(event: Extract<RuntimeStreamEvent, { type: 'final' }>): TurnUsage {
  const metadata = event.metadata ?? {}
  const tokenUsage =
    metadata.tokenUsage && typeof metadata.tokenUsage === 'object'
      ? (metadata.tokenUsage as Record<string, unknown>)
      : {}
  const input = typeof tokenUsage.input === 'number' ? tokenUsage.input : 0
  const output = typeof tokenUsage.output === 'number' ? tokenUsage.output : 0
  const costUsd = typeof metadata.costUsd === 'number' ? metadata.costUsd : undefined
  const model = typeof metadata.model === 'string' ? metadata.model : undefined
  return {
    input,
    output,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model === undefined ? {} : { model }),
  }
}

export class BraidApplication {
  readonly #execution: ExecutionPort
  readonly #admission: ApplicationAdmissionGate
  readonly #ids: IdSource
  readonly #journal: MemoryJournal
  readonly #operations = new Map<string, OperationRecord>()
  readonly #subscribers = new Set<AppSubscriber>()
  #state: BraidState
  #activeAbort: AbortController | undefined

  constructor(options: {
    readonly profile: Readonly<AgentProfile>
    readonly execution: ExecutionPort
    readonly admission: ApplicationAdmissionGate
    readonly clock: Clock
    readonly ids: IdSource
  }) {
    this.#execution = options.execution
    this.#admission = options.admission
    this.#ids = options.ids
    this.#journal = new MemoryJournal(options.clock)
    const validation = validateCanonicalProfile(options.profile)
    if (!validation.ok || validation.profile === undefined) {
      throw new AppError('INVALID_PROFILE', 'Braid application profile is invalid or oversized')
    }
    this.#state = initialState(validation.profile)
  }

  state(): BraidState {
    return structuredClone(this.#state)
  }

  events(): readonly BraidEventEnvelope[] {
    return this.#journal.all()
  }

  subscribe(subscriber: AppSubscriber): () => void {
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }

  initialize(workspace: string): BraidState {
    if (!workspace || containsControlCharacters(workspace)) {
      throw new AppError('INVALID_WORKSPACE', 'Workspace must be non-empty printable text')
    }
    if (this.#state.workspace === workspace) return this.state()
    if (this.#state.workspace !== null) {
      throw new AppError('ALREADY_INITIALIZED', 'Braid is already initialized')
    }
    this.#commit({ kind: 'workspace.opened', workspace })
    return this.state()
  }

  send(input: SendInput): SendReceipt {
    const text = input.text
    if (this.#state.workspace === null) {
      throw new AppError('NOT_INITIALIZED', 'Initialize a workspace before sending')
    }
    if (
      typeof input.operationId !== 'string' ||
      input.operationId.length === 0 ||
      input.operationId.length > 256 ||
      containsControlCharacters(input.operationId)
    ) {
      throw new AppError('OPERATION_ID_REQUIRED', 'send requires operationId')
    }
    if (typeof text !== 'string' || text.length > 262_144) {
      throw new AppError('MESSAGE_TOO_LARGE', 'Message exceeds the 262144-character limit')
    }
    if (!text.trim()) throw new AppError('EMPTY_MESSAGE', 'Message must not be empty')

    const conversationId = input.conversationId ?? this.#state.conversationId
    const branchId = input.branchId ?? this.#state.branchId
    if (conversationId !== this.#state.conversationId || branchId !== this.#state.branchId) {
      throw new AppError('UNKNOWN_BRANCH', 'The requested conversation branch is not open')
    }

    const digest = canonicalDigest({
      command: 'send',
      conversationId,
      branchId,
      text,
      profile: this.#state.profile,
    })
    const previous = this.#operations.get(input.operationId)
    if (previous) {
      if (previous.digest !== digest) {
        throw new AppError(
          'OPERATION_CONFLICT',
          `Operation ${input.operationId} was already used with different input`,
        )
      }
      return {
        operationId: input.operationId,
        runId: previous.runId,
        revision: this.#state.revision,
        replayed: true,
        completion: previous.completion.then(() => this.state()),
      }
    }
    if (this.#state.activeRunId) {
      throw new AppError('RUN_ACTIVE', `Run ${this.#state.activeRunId} is still active`)
    }

    if (this.#state.draft !== text) this.#commit({ kind: 'draft.changed', text })
    const runId = this.#ids.next('run')
    const turnId = this.#ids.next('turn')
    this.#commit({
      kind: 'run.requested',
      operationId: input.operationId,
      runId,
      turnId,
      userMessageId: this.#ids.next('message'),
      assistantMessageId: this.#ids.next('message'),
      text,
    })

    const operation: OperationRecord = {
      digest,
      runId,
      completion: Promise.resolve(),
    }
    this.#operations.set(input.operationId, operation)
    this.#activeAbort = new AbortController()
    operation.completion = this.#execute(
      input.operationId,
      runId,
      turnId,
      conversationId,
      branchId,
      text,
      this.#activeAbort,
    )

    return {
      operationId: input.operationId,
      runId,
      revision: this.#state.revision,
      replayed: false,
      completion: operation.completion.then(() => this.state()),
    }
  }

  cancelActive(): boolean {
    if (!this.#activeAbort || this.#activeAbort.signal.aborted) return false
    this.#activeAbort.abort(new Error('Cancelled by user'))
    return true
  }

  async waitForIdle(): Promise<BraidState> {
    const activeRun = this.#state.activeRunId
    if (!activeRun) return this.state()
    const operation = [...this.#operations.values()].find((entry) => entry.runId === activeRun)
    if (operation) await operation.completion
    return this.state()
  }

  async #execute(
    operationId: string,
    runId: string,
    turnId: string,
    conversationId: string,
    branchId: string,
    text: string,
    abort: AbortController,
  ): Promise<void> {
    let terminalSeen = false
    try {
      const profile = await this.#admission.admit({
        operationId,
        runId,
        turnId,
        branchId,
        conversationId,
        profile: this.#state.profile,
        text,
        workspace: this.#state.workspace ?? '',
        signal: abort.signal,
      })
      const stream = this.#execution.streamTurn({
        operationId,
        runId,
        text,
        profile,
        signal: abort.signal,
      })
      for await (const runtimeEvent of stream) {
        if (runtimeEvent.type === 'text_delta' && runtimeEvent.text) {
          this.#commit({ kind: 'run.text.delta', runId, text: runtimeEvent.text })
        } else if (runtimeEvent.type === 'final') {
          terminalSeen = true
          this.#commit({
            kind: 'run.finished',
            runId,
            status: runtimeEvent.status,
            finalText: runtimeEvent.text ?? '',
            usage: usageFromFinal(runtimeEvent),
            ...(runtimeEvent.error ? { error: redactErrorMessage(runtimeEvent.error) } : {}),
          })
        }
      }
      if (!terminalSeen) throw new Error('Runtime stream ended without a final event')
    } catch (error) {
      if (!terminalSeen) {
        const message = redactErrorMessage(error)
        this.#commit({
          kind: 'run.finished',
          runId,
          status: abort.signal.aborted ? 'aborted' : 'failed',
          finalText: '',
          usage: { input: 0, output: 0 },
          error: message,
        })
      }
    } finally {
      if (this.#activeAbort === abort) this.#activeAbort = undefined
    }
  }

  #commit(event: BraidEvent): void {
    const envelope = this.#journal.envelope(this.#state, event)
    const nextState = reduceEvent(this.#state, envelope)
    this.#journal.append(envelope)
    this.#state = nextState
    for (const subscriber of this.#subscribers) subscriber(this.state(), structuredClone(envelope))
  }
}
