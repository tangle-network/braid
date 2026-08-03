import type { AgentProfile } from '@tangle-network/agent-interface'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import type { BranchId, ConversationId, OperationId } from '../domain/ids.js'
import { parseOperationId } from '../domain/ids.js'
import { assertBraidState } from '../domain/invariants.js'
import { redactBraidEvent, redactSensitiveText } from '../domain/redaction.js'
import { reduceEvent, replayEvents } from '../domain/reducer.js'
import { type BraidState, initialState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type {
  EffectStoragePort,
  JournalPort,
  EffectRecord as StoredEffectRecord,
} from '../ports/effect-storage.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import { effectRequestDigest, SerializedEffectCoordinator } from './effect-coordinator.js'
import { projectEffectRecord } from './effect-projection.js'
import { FailClosedJournal } from './fail-closed-journal.js'
import {
  cancelRequestDigest,
  DEFAULT_CANCEL_REASON,
  OperationLedger,
  type OperationRecord,
  shutdownRequestDigest,
} from './operation-ledger.js'
import { safeDiagnostic } from './provider-values.js'
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

export type CancelReceipt = SendReceipt

export interface ShutdownReceipt {
  readonly operationId: string
  readonly revision: number
  readonly replayed: boolean
  readonly completion: Promise<BraidState>
}

export interface BraidApplicationOptions {
  readonly profile: Readonly<AgentProfile>
  readonly execution: ExecutionPort
  readonly clock: Clock
  readonly ids: IdSource
  readonly journal?: JournalPort
  readonly effectStorage?: EffectStoragePort
  readonly effectCoordinator?: SerializedEffectCoordinator
  readonly conversationId?: ConversationId
  readonly branchId?: BranchId
  readonly cancelTimeoutMs?: number
}

const CANCEL_WAIT_MS = 5_000
const MAX_MESSAGE_BYTES = 1024 * 1024
const RUN_EFFECT_KIND = 'run.execute'

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
  readonly #effects: SerializedEffectCoordinator
  readonly #operations = new OperationLedger()
  readonly #subscribers = new Set<AppSubscriber>()
  readonly #lifecycle: RunLifecycle
  #state: BraidState

  constructor(options: BraidApplicationOptions) {
    this.#ids = options.ids
    const executionProfile = structuredClone(options.profile)
    const defaultJournal = new FailClosedJournal(options.clock)
    this.#journal = options.journal ?? defaultJournal
    this.#effects =
      options.effectCoordinator ??
      new SerializedEffectCoordinator(options.effectStorage ?? defaultJournal, options.clock, {
        onRecord: (record) => this.#recordEffect(record),
      })
    const persisted = this.#journal.all()
    this.#state = replayEvents(
      initialState(executionProfile, {
        ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
        ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      }),
      persisted,
    )
    assertBraidState(this.#state)
    this.#lifecycle = new RunLifecycle({
      execution: options.execution,
      profile: executionProfile,
      cancelTimeoutMs: options.cancelTimeoutMs ?? CANCEL_WAIT_MS,
      state: () => this.state(),
      commit: (event) => this.#commit(event),
      flush: () => this.#journal.flush?.() ?? Promise.resolve(),
    })
    this.#operations.restore(persisted)
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
    if (this.#state.workspace === null) {
      throw new AppError('NOT_INITIALIZED', 'Initialize a workspace before sending')
    }
    const operationId = this.#operationId(input.operationId, 'send')
    if (Buffer.byteLength(input.text, 'utf8') > MAX_MESSAGE_BYTES) {
      throw new AppError('MESSAGE_TOO_LARGE', 'Message must not exceed 1 MiB')
    }
    const text = redactSensitiveText(input.text)
    if (!text.trim()) throw new AppError('EMPTY_MESSAGE', 'Message must not be empty')

    const conversationId = input.conversationId ?? this.#state.conversationId
    const branchId = input.branchId ?? this.#state.branchId
    if (conversationId !== this.#state.conversationId || branchId !== this.#state.branchId) {
      throw new AppError('UNKNOWN_BRANCH', 'The requested conversation branch is not open')
    }

    const intent = {
      operationId,
      effectKind: RUN_EFFECT_KIND,
      request: { conversationId, branchId, text, profile: this.#state.profile },
    } as const
    const digest = effectRequestDigest(intent)
    const replayed = this.#admitSend(operationId, digest)
    if (replayed) return replayed

    if (this.#state.activeRunId) {
      throw new AppError('RUN_ACTIVE', `Run ${this.#state.activeRunId} is still active`)
    }
    if (this.#state.draft !== text) this.#commit({ kind: 'draft.changed', text })
    const runId = this.#ids.next('run')
    const turnId = this.#ids.next('turn')
    this.#commit({
      kind: 'run.requested',
      operationId,
      requestDigest: digest,
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
    this.#operations.set(operationId, operation)
    try {
      const effect = this.#effects.start(
        { ...intent, metadata: { runId, turnId } },
        { dispatch: (context) => this.#lifecycle.execute(context.operationId, runId, text) },
      )
      operation.completion = effect.completion.then(async () => {
        await this.#journal.flush?.()
      })
    } catch (error) {
      this.#operations.delete(operationId)
      this.#abandonRun(runId, error)
      throw error
    }

    return {
      operationId,
      runId,
      revision: this.#state.revision,
      replayed: false,
      completion: operation.completion.then(() => this.state()),
    }
  }

  cancel(input: CancelInput): CancelReceipt {
    const operationId = this.#operationId(input.operationId, 'cancel')
    const existing = this.#operations.get(operationId)
    const runId = input.runId ?? this.#state.activeRunId ?? existing?.runId
    if (!runId) throw new AppError('UNKNOWN_RUN', 'There is no run to cancel')
    const reason = redactSensitiveText(input.reason ?? DEFAULT_CANCEL_REASON)
    const digest = cancelRequestDigest(runId, reason)
    if (existing) return this.#replayReceipt(operationId, existing, 'cancel', digest)

    if (this.#state.activeRunId !== runId) {
      throw new AppError('UNKNOWN_RUN', `Run ${runId} is not active`)
    }
    const run = this.#state.runs.find((candidate) => candidate.id === runId)
    if (run?.status !== 'streaming') {
      throw new AppError('UNKNOWN_RUN', `Run ${runId} is not cancellable`)
    }
    const operation: OperationRecord = {
      kind: 'cancel',
      digest,
      runId,
      completion: Promise.resolve(),
    }
    this.#operations.set(operationId, operation)
    operation.completion = this.#lifecycle.startCancellation(operationId, runId, reason)
    return {
      operationId,
      runId,
      revision: this.#state.revision,
      replayed: false,
      completion: operation.completion.then(() => this.state()),
    }
  }

  cancelActive(): boolean {
    const runId = this.#state.activeRunId
    if (!runId || !this.#lifecycle.canCancel()) return false
    try {
      this.cancel({ operationId: this.#ids.next('operation'), runId })
      return true
    } catch {
      return false
    }
  }

  canCancel(): boolean {
    return this.#lifecycle.canCancel()
  }

  shutdown(input: { readonly operationId: string }): ShutdownReceipt {
    const operationId = this.#operationId(input.operationId, 'shutdown')
    const digest = shutdownRequestDigest()
    const existing = this.#operations.get(operationId)
    if (existing) {
      const replay = this.#replayReceipt(operationId, existing, 'shutdown', digest)
      return {
        operationId: replay.operationId,
        revision: replay.revision,
        replayed: replay.replayed,
        completion: replay.completion,
      }
    }
    this.#commit({ kind: 'application.shutdown.requested', operationId })
    const runId = this.#state.activeRunId
    const run = runId ? this.#state.runs.find((candidate) => candidate.id === runId) : undefined
    const operation: OperationRecord = {
      kind: 'shutdown',
      digest,
      ...(runId ? { runId } : {}),
      completion: Promise.resolve(),
    }
    this.#operations.set(operationId, operation)
    operation.completion =
      runId && run?.status === 'streaming'
        ? this.#lifecycle.startCancellation(operationId, runId, 'Shutdown requested')
        : this.waitForIdle().then(() => undefined)
    return {
      operationId,
      revision: this.#state.revision,
      replayed: false,
      completion: operation.completion.then(() => this.state()),
    }
  }

  async waitForIdle(): Promise<BraidState> {
    const activeRun = this.#state.activeRunId
    if (!activeRun) return this.state()
    const pending = this.#operations.forRun(activeRun)
    const operation =
      pending.find((entry) => entry.kind === 'cancel') ??
      pending.find((entry) => entry.kind === 'send')
    if (operation) await operation.completion
    return this.state()
  }

  async close(): Promise<void> {
    await this.#journal.close?.()
  }

  #operationId(value: string, command: string): OperationId {
    try {
      return parseOperationId(value)
    } catch {
      throw new AppError('INVALID_OPERATION_ID', `${command} requires a valid operationId`)
    }
  }

  /**
   * Decides whether a send may dispatch, is an exact replay, or must be
   * reconciled. Durable effect storage answers this across process restarts;
   * the in-process ledger only shortens the answer for a live operation.
   */
  #admitSend(operationId: OperationId, digest: string): SendReceipt | undefined {
    const persisted = this.#effects.current(operationId)
    if (persisted && persisted.requestDigest !== digest) {
      this.#effects.start(
        { operationId, effectKind: RUN_EFFECT_KIND, request: { digest } },
        { dispatch: async () => ({ status: 'failed', detail: 'OPERATION_CONFLICT' }) },
      )
      throw new AppError(
        'OPERATION_CONFLICT',
        `Operation ${operationId} was already used with different input`,
      )
    }
    const previous = this.#operations.get(operationId)
    if (previous) {
      const replay = this.#replayReceipt(operationId, previous, 'send', digest)
      if (!previous.runId) throw new AppError('OPERATION_CONFLICT', 'Operation has no run')
      return replay
    }
    if (!persisted) return undefined
    const persistedRun = this.#state.runs.find((run) => run.operationId === operationId)
    if (persisted.status !== 'pending' && persisted.status !== 'conflict' && persistedRun) {
      return {
        operationId,
        runId: persistedRun.id,
        revision: this.#state.revision,
        replayed: true,
        completion: Promise.resolve(this.state()),
      }
    }
    throw new AppError(
      'OPERATION_REQUIRES_RECONCILIATION',
      `Operation ${operationId} needs provider reconciliation before it can be retried`,
    )
  }

  #replayReceipt(
    operationId: OperationId,
    existing: OperationRecord,
    kind: OperationRecord['kind'],
    digest: string,
  ): SendReceipt {
    if (existing.kind !== kind || existing.digest !== digest) {
      throw new AppError(
        'OPERATION_CONFLICT',
        `Operation ${operationId} was already used with different input`,
      )
    }
    return {
      operationId,
      runId: existing.runId ?? '',
      revision: this.#state.revision,
      replayed: true,
      completion: existing.completion.then(() => this.state()),
    }
  }

  /** A run that never reached durable admission must not stay active forever. */
  #abandonRun(runId: string, cause: unknown): void {
    if (this.#state.activeRunId !== runId) return
    try {
      this.#commit({
        kind: 'run.finished',
        runId,
        status: 'failed',
        finalText: '',
        usage: { input: 0, output: 0 },
        error: safeDiagnostic(
          cause instanceof Error ? cause.message : cause,
          'EFFECT_START_FAILED',
        ),
      })
    } catch {
      // The original journal failure is the actionable error.
    }
  }

  #commit(event: BraidEvent): void {
    const envelope = this.#journal.envelope(this.#state, redactBraidEvent(event))
    const nextState = reduceEvent(this.#state, envelope)
    this.#journal.append(envelope)
    this.#state = nextState
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(this.state(), structuredClone(envelope))
      } catch {
        // Observers cannot change whether a durable application transition succeeds.
      }
    }
  }

  #recordEffect(record: StoredEffectRecord): void {
    this.#commit({ kind: 'effect.upserted', effect: projectEffectRecord(record) })
  }
}
