import { MAX_ID_BYTES, MAX_TEXT_BYTES, utf8Bytes } from '../domain/bounds.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEventEnvelope } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { IdSource } from '../ports/ids.js'
import {
  type OperationAuthority,
  OperationConflictError,
  assertOperationId,
  type OperationRecord as AuthorityOperationRecord,
} from '../domain/operation-authority.js'
import type { ApplicationStateStore } from './application-state.js'
import { sendOperationForRun, type SendOperationRecord } from './send-operation.js'
import type { RunExecutionService } from './run-execution.js'
import { AppError } from './errors.js'

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

export class RunAdmissionService {
  readonly #state: ApplicationStateStore
  readonly #ids: IdSource
  readonly #operations: OperationAuthority
  readonly #execution: RunExecutionService

  constructor(options: {
    readonly state: ApplicationStateStore
    readonly ids: IdSource
    readonly operations: OperationAuthority
    readonly execution: RunExecutionService
  }) {
    this.#state = options.state
    this.#ids = options.ids
    this.#operations = options.operations
    this.#execution = options.execution
  }

  send(input: SendInput): SendReceipt {
    const state = this.#state.state()
    if (state.workspace === null) {
      throw new AppError('NOT_INITIALIZED', 'Initialize a workspace before sending')
    }
    try {
      assertOperationId(input.operationId)
    } catch (error) {
      throw new AppError(
        'OPERATION_ID_REQUIRED',
        error instanceof Error ? error.message : 'send requires operationId',
      )
    }
    if (!input.text.trim()) throw new AppError('EMPTY_MESSAGE', 'Message must not be empty')
    if (utf8Bytes(input.text) > MAX_TEXT_BYTES) {
      throw new AppError('INPUT_TOO_LARGE', 'Message exceeds the UTF-8 byte limit')
    }
    const conversationId = input.conversationId ?? state.conversationId
    const branchId = input.branchId ?? state.branchId
    if (input.conversationId !== undefined && utf8Bytes(input.conversationId) > MAX_ID_BYTES) {
      throw new AppError('INPUT_TOO_LARGE', 'conversationId exceeds the UTF-8 byte limit')
    }
    if (input.branchId !== undefined && utf8Bytes(input.branchId) > MAX_ID_BYTES) {
      throw new AppError('INPUT_TOO_LARGE', 'branchId exceeds the UTF-8 byte limit')
    }
    if (conversationId !== state.conversationId || branchId !== state.branchId) {
      throw new AppError('UNKNOWN_BRANCH', 'The requested conversation branch is not open')
    }
    const digest = canonicalDigest({
      schema: 'braid.send.v1',
      workspace: state.workspace,
      conversationId,
      branchId,
      text: input.text,
      profile: state.profile,
      model: state.profile.model?.default,
    })
    let previous: AuthorityOperationRecord<SendOperationRecord> | undefined
    try {
      previous = this.#operations.get<SendOperationRecord>(input.operationId, digest)
    } catch (error) {
      if (error instanceof OperationConflictError) {
        throw new AppError('OPERATION_CONFLICT', 'Operation was already used with different input')
      }
      throw error
    }
    if (previous) {
      return {
        operationId: input.operationId,
        runId: previous.value.runId,
        revision: this.#state.state().revision,
        replayed: true,
        completion: previous.value.completion.then(() => this.#state.state()),
      }
    }
    if (state.activeRunId) {
      throw new AppError('RUN_ACTIVE', `Run ${state.activeRunId} is still active`)
    }
    if (state.draft !== input.text) this.#state.commit({ kind: 'draft.changed', text: input.text })
    const afterDraft = this.#state.state()
    const runId = this.#ids.next('run')
    const turnId = this.#ids.next('turn')
    this.#state.commit({
      kind: 'run.requested',
      operationId: input.operationId,
      runId,
      turnId,
      userMessageId: this.#ids.next('message'),
      assistantMessageId: this.#ids.next('message'),
      text: input.text,
      requestDigest: digest,
      profileDigest: canonicalDigest(afterDraft.profile),
      ...(afterDraft.workspace === null ? {} : { workspaceId: afterDraft.workspace }),
      conversationId,
      branchId,
      ...(afterDraft.profile.model?.default === undefined
        ? {}
        : { model: afterDraft.profile.model.default }),
    })
    const abort = new AbortController()
    let resolveCompletion: () => void = () => {}
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })
    this.#operations.remember(input.operationId, digest, { runId, completion })
    void this.#execution
      .start({ operationId: input.operationId, runId, text: input.text, signal: abort })
      .then(resolveCompletion, resolveCompletion)
    return {
      operationId: input.operationId,
      runId,
      revision: this.#state.state().revision,
      replayed: false,
      completion: completion.then(() => this.#state.state()),
    }
  }

  cancelActive(): boolean {
    return this.#execution.cancelActive()
  }

  async waitForIdle(): Promise<BraidState> {
    const state = this.#state.state()
    if (!state.activeRunId) return state
    const operation = sendOperationForRun(this.#operations, state, state.activeRunId)
    if (operation) await operation.completion
    return this.#state.state()
  }

  rehydrate(events: readonly BraidEventEnvelope[]): void {
    const state = this.#state.state()
    for (const envelope of events) {
      if (envelope.event.kind !== 'run.requested') continue
      const event = envelope.event
      const digest =
        event.requestDigest ??
        canonicalDigest({
          schema: 'braid.send.v1',
          workspace: state.workspace,
          conversationId: event.conversationId ?? state.conversationId,
          branchId: event.branchId ?? state.branchId,
          text: event.text,
          profile: state.profile,
          model: state.profile.model?.default,
        })
      this.#operations.remember(event.operationId, digest, {
        runId: event.runId,
        completion: Promise.resolve(),
      })
    }
  }
}
