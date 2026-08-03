import type { AgentProfile } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { canonicalDigest } from '../domain/canonical.js'
import type { EffectRecord as DomainEffectRecord, OperationKind } from '../domain/entities.js'
import type { BraidEvent, BraidEventEnvelope, TurnUsage } from '../domain/events.js'
import type { BranchId, ConversationId } from '../domain/ids.js'
import { createEffectId, type Digest, type OperationId, parseOperationId } from '../domain/ids.js'
import { assertBraidState } from '../domain/invariants.js'
import { reduceEvent, replayEvents } from '../domain/reducer.js'
import { type BraidState, initialState } from '../domain/state.js'
import { containsUnsafeControlCharacter } from '../domain/text.js'
import type { Clock } from '../ports/clock.js'
import type {
  EffectStoragePort,
  JournalPort,
  EffectRecord as StoredEffectRecord,
} from '../ports/effect-storage.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import {
  type EffectDispatchResult,
  effectRequestDigest,
  SerializedEffectCoordinator,
} from './effect-coordinator.js'
import { FailClosedJournal } from './fail-closed-journal.js'

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
  const input = finiteNonNegativeNumber(tokenUsage.input)
  const output = finiteNonNegativeNumber(tokenUsage.output)
  const costUsd = finiteNonNegativeNumber(metadata.costUsd, undefined)
  const model = safePublicIdentifier(metadata.model)
  return {
    input,
    output,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model === undefined ? {} : { model }),
  }
}

function finiteNonNegativeNumber(value: unknown): number
function finiteNonNegativeNumber(value: unknown, fallback: undefined): number | undefined
function finiteNonNegativeNumber(value: unknown, fallback = 0): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function safePublicIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(text) && !SENSITIVE_DIAGNOSTIC.test(text)
    ? text
    : undefined
}

const SENSITIVE_DIAGNOSTIC =
  /(?:secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key|session(?:[_-]?key)?|access[_-]?key|client[_-]?secret|signature|signed[_-]?url|nonce)/iu
const SAFE_DIAGNOSTIC = /^[A-Za-z0-9][A-Za-z0-9 .,_'()[\]-]{0,159}$/u

function safeDiagnostic(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (
    text.length === 0 ||
    !SAFE_DIAGNOSTIC.test(text) ||
    containsUnsafeControlCharacter(text) ||
    SENSITIVE_DIAGNOSTIC.test(text)
  ) {
    return fallback
  }
  return text
}

export class BraidApplication {
  readonly #execution: ExecutionPort
  readonly #ids: IdSource
  readonly #journal: JournalPort
  readonly #effects: SerializedEffectCoordinator
  readonly #operations = new Map<string, OperationRecord>()
  readonly #subscribers = new Set<AppSubscriber>()
  #state: BraidState
  #activeAbort: AbortController | undefined

  constructor(options: {
    readonly profile: Readonly<AgentProfile>
    readonly execution: ExecutionPort
    readonly clock: Clock
    readonly ids: IdSource
    readonly journal?: JournalPort
    readonly effectStorage?: EffectStoragePort
    readonly effectCoordinator?: SerializedEffectCoordinator
    readonly conversationId?: ConversationId
    readonly branchId?: BranchId
  }) {
    this.#execution = options.execution
    this.#ids = options.ids
    const defaultJournal = new FailClosedJournal(options.clock)
    this.#journal = options.journal ?? defaultJournal
    this.#effects =
      options.effectCoordinator ??
      new SerializedEffectCoordinator(options.effectStorage ?? defaultJournal, options.clock, {
        onRecord: (record) => this.#recordEffect(record),
      })
    const baseState = initialState(structuredClone(options.profile), {
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
    })
    this.#state = replayEvents(baseState, this.#journal.all())
    assertBraidState(this.#state)
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
    const text = input.text
    if (this.#state.workspace === null) {
      throw new AppError('NOT_INITIALIZED', 'Initialize a workspace before sending')
    }
    let operationId: OperationId
    try {
      operationId = parseOperationId(input.operationId)
    } catch {
      throw new AppError('INVALID_OPERATION_ID', 'send requires a valid operationId')
    }
    if (!text.trim()) throw new AppError('EMPTY_MESSAGE', 'Message must not be empty')
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
      throw new AppError('MESSAGE_TOO_LARGE', 'Message must not exceed 1 MiB')
    }

    const conversationId = input.conversationId ?? this.#state.conversationId
    const branchId = input.branchId ?? this.#state.branchId
    if (conversationId !== this.#state.conversationId || branchId !== this.#state.branchId) {
      throw new AppError('UNKNOWN_BRANCH', 'The requested conversation branch is not open')
    }

    const effectIntent = {
      operationId,
      effectKind: 'run.execute',
      request: { conversationId, branchId, text, profile: this.#state.profile },
    } as const
    const digest = effectRequestDigest(effectIntent)
    const persisted = this.#effects.current(operationId)
    if (persisted && persisted.requestDigest !== digest) {
      this.#effects.start(effectIntent, {
        dispatch: async () => ({ status: 'failed', detail: 'OPERATION_CONFLICT' }),
      })
      throw new AppError(
        'OPERATION_CONFLICT',
        `Operation ${operationId} was already used with different input`,
      )
    }
    const previous = this.#operations.get(operationId)
    if (!previous && persisted) {
      if (
        persisted.status === 'terminal' ||
        persisted.status === 'acknowledged' ||
        persisted.status === 'failed'
      ) {
        const persistedRun = this.#state.runs.find((run) => run.operationId === operationId)
        if (persistedRun) {
          return {
            operationId,
            runId: persistedRun.id,
            revision: this.#state.revision,
            replayed: true,
            completion: Promise.resolve(this.state()),
          }
        }
      }
      throw new AppError(
        'OPERATION_REQUIRES_RECONCILIATION',
        `Operation ${operationId} needs provider reconciliation before it can be retried`,
      )
    }
    if (previous) {
      if (previous.digest !== digest) {
        throw new AppError(
          'OPERATION_CONFLICT',
          `Operation ${operationId} was already used with different input`,
        )
      }
      return {
        operationId,
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
      operationId,
      requestDigest: digest,
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
    this.#operations.set(operationId, operation)
    const abort = new AbortController()
    this.#activeAbort = abort
    try {
      const effect = this.#effects.start(
        {
          ...effectIntent,
          metadata: { runId, turnId },
        },
        {
          dispatch: (context) => this.#execute(context.operationId, runId, text, abort),
        },
      )
      operation.completion = effect.completion.then(async () => {
        await this.#journal.flush?.()
      })
    } catch (error) {
      if (this.#activeAbort) this.#activeAbort = undefined
      this.#operations.delete(operationId)
      if (this.#state.activeRunId === runId) {
        try {
          this.#commit({
            kind: 'run.finished',
            runId,
            status: 'failed',
            finalText: '',
            usage: { input: 0, output: 0 },
            error: safeDiagnostic(
              error instanceof Error ? error.message : error,
              'EFFECT_START_FAILED',
            ),
          })
        } catch {
          // The original journal failure is the actionable error.
        }
      }
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

  async close(): Promise<void> {
    await this.#journal.close?.()
  }

  async #execute(
    operationId: string,
    runId: string,
    text: string,
    abort: AbortController,
  ): Promise<EffectDispatchResult> {
    let terminalSeen = false
    let terminalDurable = false
    let terminalStatus: string | undefined
    let dispatchStarted = false
    try {
      await this.#journal.flush?.()
      dispatchStarted = true
      const stream = this.#execution.streamTurn({
        operationId,
        runId,
        text,
        profile: this.#state.profile,
        signal: abort.signal,
      })
      for await (const runtimeEvent of stream) {
        if (runtimeEvent.type === 'text_delta' && runtimeEvent.text) {
          this.#commit({ kind: 'run.text.delta', runId, text: runtimeEvent.text })
        } else if (runtimeEvent.type === 'final' && !terminalSeen) {
          terminalStatus = runtimeEvent.status
          this.#commit({
            kind: 'run.finished',
            runId,
            status: runtimeEvent.status,
            finalText: runtimeEvent.text ?? '',
            usage: usageFromFinal(runtimeEvent),
            ...(runtimeEvent.error
              ? { error: safeDiagnostic(runtimeEvent.error.message, 'RUNTIME_FINAL_ERROR') }
              : {}),
          })
          terminalSeen = true
          await this.#journal.flush?.()
          terminalDurable = true
          break
        }
      }
      if (!terminalSeen) throw new Error('Runtime stream ended without a final event')
      return {
        status: terminalStatus === 'completed' ? 'terminal' : 'failed',
        ...(terminalStatus === undefined ? {} : { detail: terminalStatus }),
      }
    } catch (error) {
      if (!terminalDurable) {
        const message = safeDiagnostic(
          error instanceof Error ? error.message : String(error),
          dispatchStarted ? 'RUNTIME_STREAM_ERROR' : 'RUNTIME_DISPATCH_ERROR',
        )
        try {
          this.#commit({
            kind: 'run.finished',
            runId,
            status: abort.signal.aborted ? 'aborted' : dispatchStarted ? 'unknown' : 'failed',
            finalText: '',
            usage: { input: 0, output: 0 },
            error: message,
          })
          await this.#journal.flush?.()
        } catch (commitError) {
          return {
            status: dispatchStarted ? 'unknown' : 'failed',
            detail: safeDiagnostic(
              commitError instanceof Error ? commitError.message : commitError,
              dispatchStarted ? 'RUNTIME_OUTCOME_NOT_DURABLE' : 'RUNTIME_FAILURE_NOT_DURABLE',
            ),
          }
        }
      }
      return terminalDurable
        ? {
            status: terminalStatus === 'completed' ? 'terminal' : 'failed',
            ...(terminalStatus === undefined ? {} : { detail: terminalStatus }),
          }
        : {
            status: dispatchStarted ? 'unknown' : 'failed',
            detail: safeDiagnostic(
              error instanceof Error ? error.message : error,
              dispatchStarted ? 'RUNTIME_OUTCOME_UNKNOWN' : 'RUNTIME_DISPATCH_FAILED',
            ),
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
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(this.state(), structuredClone(envelope))
      } catch {
        // Observers cannot change whether a durable application transition succeeds.
      }
    }
  }

  #recordEffect(record: StoredEffectRecord): void {
    const effectId = createEffectId(
      `effect-${record.operationId}-${record.requestDigest.slice(0, 24)}`,
    )
    const outcomeDigest =
      record.detail === undefined && record.externalReference === undefined
        ? undefined
        : canonicalDigest({
            status: record.status,
            detail: record.detail ?? null,
            externalReference: record.externalReference ?? null,
          })
    const operationKind: OperationKind = record.effectKind === 'run.execute' ? 'send' : 'custom'
    const effect: DomainEffectRecord = {
      id: effectId,
      operationId: record.operationId as import('../domain/ids.js').OperationId,
      effectKind: record.effectKind,
      requestDigest: record.requestDigest as Digest,
      kind: operationKind,
      status: record.status,
      attempt: record.attempt,
      ...(outcomeDigest === undefined ? {} : { outcomeDigest: outcomeDigest as Digest }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
    this.#commit({ kind: 'effect.upserted', effect })
  }
}
