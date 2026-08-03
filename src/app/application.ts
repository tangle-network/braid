import type { AgentProfile } from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { reduceEvent, replayEvents } from '../domain/reducer.js'
import { redactBraidEvent, redactProfile, redactSensitiveText } from '../domain/redaction.js'
import { initialState, type BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import type { JournalPort } from './journal.js'
import { MemoryJournal } from './journal.js'
import { OperationLedger, type OperationRecord } from './operation-ledger.js'
import { RunLifecycle } from './run-lifecycle.js'

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

export interface CancelInput {
  readonly operationId: string
  readonly runId?: string
  readonly reason?: string
}

export interface CancelReceipt {
  readonly operationId: string
  readonly runId: string
  readonly revision: number
  readonly replayed: boolean
  readonly completion: Promise<BraidState>
}

export interface ShutdownReceipt {
  readonly operationId: string
  readonly revision: number
  readonly replayed: boolean
  readonly completion: Promise<BraidState>
}

const CANCEL_WAIT_MS = 5_000

export class AppError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }
}

export class BraidApplication {
  readonly #ids: IdSource
  readonly #journal: JournalPort
  readonly #operations = new OperationLedger()
  readonly #subscribers = new Set<AppSubscriber>()
  readonly #lifecycle: RunLifecycle
  #state: BraidState

  constructor(options: {
    readonly profile: Readonly<AgentProfile>
    readonly execution: ExecutionPort
    readonly clock: Clock
    readonly ids: IdSource
    readonly journal?: JournalPort
    readonly replay?: readonly BraidEventEnvelope[]
    readonly cancelTimeoutMs?: number
  }) {
    this.#ids = options.ids
    const executionProfile = structuredClone(options.profile)
    const profile = redactProfile(executionProfile)
    const initial = initialState(profile)
    this.#journal = options.journal ?? new MemoryJournal(options.clock, options.replay ?? [])
    const persisted = this.#journal.all()
    this.#state = persisted.length ? replayEvents(initial, persisted) : initial
    this.#lifecycle = new RunLifecycle({
      execution: options.execution,
      profile: executionProfile,
      cancelTimeoutMs: options.cancelTimeoutMs ?? CANCEL_WAIT_MS,
      state: () => this.state(),
      commit: (event) => this.#commit(event),
    })
    this.#operations.restore(persisted, this.#state)
    this.#lifecycle.reconcileAfterRestart()
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
    if (!workspace) throw new AppError('INVALID_WORKSPACE', 'Workspace must not be empty')
    if (this.#state.workspace === workspace) return this.state()
    if (this.#state.workspace !== null) {
      throw new AppError('ALREADY_INITIALIZED', 'Braid is already initialized')
    }
    this.#commit({ kind: 'workspace.opened', workspace })
    return this.state()
  }

  send(input: SendInput): SendReceipt {
    const text = redactSensitiveText(input.text)
    if (this.#state.workspace === null) {
      throw new AppError('NOT_INITIALIZED', 'Initialize a workspace before sending')
    }
    if (!input.operationId) {
      throw new AppError('OPERATION_ID_REQUIRED', 'send requires operationId')
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
      if (!previous.runId) throw new AppError('OPERATION_CONFLICT', 'Operation has no run')
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
      kind: 'send',
      digest,
      runId,
      completion: Promise.resolve(),
    }
    this.#operations.set(input.operationId, operation)
    operation.completion = this.#lifecycle.execute(input.operationId, runId, text)

    return {
      operationId: input.operationId,
      runId,
      revision: this.#state.revision,
      replayed: false,
      completion: operation.completion.then(() => this.state()),
    }
  }

  cancel(input: CancelInput): CancelReceipt {
    if (!input.operationId) {
      throw new AppError('OPERATION_ID_REQUIRED', 'cancel requires operationId')
    }
    const existing = this.#operations.get(input.operationId)
    const runId = input.runId ?? this.#state.activeRunId ?? existing?.runId
    if (!runId) throw new AppError('UNKNOWN_RUN', 'There is no run to cancel')
    const reason = redactSensitiveText(input.reason ?? 'Cancelled by user')
    const digest = canonicalDigest({ command: 'cancel_run', runId, reason })
    if (existing) {
      if (existing.kind !== 'cancel' || existing.digest !== digest) {
        throw new AppError(
          'OPERATION_CONFLICT',
          `Operation ${input.operationId} was already used with different input`,
        )
      }
      if (!existing.runId) throw new AppError('OPERATION_CONFLICT', 'Operation has no run')
      return {
        operationId: input.operationId,
        runId: existing.runId,
        revision: this.#state.revision,
        replayed: true,
        completion: existing.completion.then(() => this.state()),
      }
    }
    if (this.#state.activeRunId !== runId) {
      throw new AppError('UNKNOWN_RUN', `Run ${runId} is not active`)
    }
    const run = this.#state.runs.find((candidate) => candidate.id === runId)
    if (
      !run ||
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'aborted' ||
      run.status === 'unknown' ||
      run.status === 'cancelling'
    ) {
      throw new AppError('UNKNOWN_RUN', `Run ${runId} is not cancellable`)
    }
    const operation: OperationRecord = {
      kind: 'cancel',
      digest,
      runId,
      completion: Promise.resolve(),
    }
    this.#operations.set(input.operationId, operation)
    operation.completion = this.#lifecycle.startCancellation(input.operationId, runId, reason)
    return {
      operationId: input.operationId,
      runId,
      revision: this.#state.revision,
      replayed: false,
      completion: operation.completion.then(() => this.state()),
    }
  }

  cancelActive(): boolean {
    if (!this.#lifecycle.hasActiveExecution) return false
    try {
      this.cancel({ operationId: this.#ids.next('operation') })
      return true
    } catch {
      return false
    }
  }

  canCancel(): boolean {
    return this.#lifecycle.canCancel()
  }

  shutdown(input: { readonly operationId: string }): ShutdownReceipt {
    if (!input.operationId) {
      throw new AppError('OPERATION_ID_REQUIRED', 'shutdown requires operationId')
    }
    const digest = canonicalDigest({ command: 'shutdown' })
    const existing = this.#operations.get(input.operationId)
    if (existing) {
      if (existing.kind !== 'shutdown' || existing.digest !== digest) {
        throw new AppError(
          'OPERATION_CONFLICT',
          `Operation ${input.operationId} was already used with different input`,
        )
      }
      return {
        operationId: input.operationId,
        revision: this.#state.revision,
        replayed: true,
        completion: existing.completion.then(() => this.state()),
      }
    }
    this.#commit({ kind: 'application.shutdown.requested', operationId: input.operationId })
    const operation: OperationRecord = {
      kind: 'shutdown',
      digest,
      ...(this.#state.activeRunId ? { runId: this.#state.activeRunId } : {}),
      completion: Promise.resolve(),
    }
    this.#operations.set(input.operationId, operation)
    const runId = this.#state.activeRunId
    const run = runId ? this.#state.runs.find((candidate) => candidate.id === runId) : undefined
    if (runId && run?.status === 'streaming') {
      operation.completion = this.#lifecycle.startCancellation(
        input.operationId,
        runId,
        'Shutdown requested',
      )
    } else {
      operation.completion = this.waitForIdle().then(() => undefined)
    }
    return {
      operationId: input.operationId,
      revision: this.#state.revision,
      replayed: false,
      completion: operation.completion.then(() => this.state()),
    }
  }

  async waitForIdle(): Promise<BraidState> {
    const activeRun = this.#state.activeRunId
    if (!activeRun) return this.state()
    const operation =
      this.#operations.forRun(activeRun).find((entry) => entry.kind === 'cancel') ??
      this.#operations.forRun(activeRun).find((entry) => entry.kind === 'send')
    if (operation) await operation.completion
    return this.state()
  }

  #commit(event: BraidEvent): void {
    const envelope = this.#journal.envelope(this.#state, redactBraidEvent(event))
    const nextState = reduceEvent(this.#state, envelope)
    this.#journal.append(envelope)
    this.#state = nextState
    for (const subscriber of this.#subscribers) subscriber(this.state(), structuredClone(envelope))
  }
}
