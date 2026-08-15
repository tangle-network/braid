import { randomUUID } from 'node:crypto'
import type { AgentProfile, InteractionResponse } from '@tangle-network/agent-interface'
import { canonicalAgentProfileDigestHex } from '../adapters/agent-interface/profile-runtime.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { providerEventKey } from '../domain/events.js'
import { assertBraidState } from '../domain/invariants.js'
import type {
  ContextTransferReceipt,
  NativeContextBoundaryProof,
  RunAdmissionReceipt,
} from '../domain/receipts.js'
import { redactSensitiveText } from '../domain/redaction.js'
import { replayEvents } from '../domain/reducer.js'
import type { RuntimeEventEnvelope } from '../domain/runtime-events.js'
import { type BraidState, initialState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { ExecuteTurnInput, ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import { snapshotAnalysisExecutionTarget } from './analysis-execution-target.js'
import { admissionIsAsync, assertWritable, operationId } from './application-guards.js'
import { ApplicationInteractionActions } from './application-interaction-actions.js'
import { ApplicationLifecycle } from './application-lifecycle.js'
import type { BraidApplicationOptions, CancelInput, CancelReceipt } from './application-options.js'
import type { PortViews } from './application-port-builder.js'
import type {
  ControlEffectRequest,
  ReconnectInput,
  RuntimeEventIngestionResult,
} from './application-ports.js'
import { wireApplicationRuntime } from './application-runtime-wiring.js'
import type {
  AppSubscriber,
  ControlReceipt,
  InteractionReceipt,
  QueueReceipt,
  SendInput,
  SendReceipt,
  ShutdownReceipt,
} from './application-types.js'
import type { AutomationActions } from './automation-actions.js'
import { executeControlEffect } from './control-effects.js'
import { createConversationActions } from './conversation-composition.js'
import { ConversationOperationCoordinator } from './conversation-operation-coordinator.js'
import type { ConversationActions } from './conversations.js'
import { createDurableSender } from './durable-send.js'
import { SerializedEffectCoordinator } from './effect-coordinator.js'
import { projectEffectRecord } from './effect-projection.js'
import { effectiveRunConfiguration } from './effective-run-configuration.js'
import { AppError } from './errors.js'
import { FailClosedJournal } from './fail-closed-journal.js'
import { createIntelligenceActions, type IntelligenceActions } from './intelligence-actions.js'
import { MemoryJournal } from './journal.js'
import { legacyCancel } from './legacy-cancel.js'
import {
  admitRun,
  continueNative,
  runEffectRequest,
  sendRun,
  sendRunAsync,
  validateNativeProof,
} from './run-admission.js'
import { cancelRun, detachRun, queueRunInput, steerRun } from './run-controls.js'
import type { RunExecutionSnapshot } from './run-execution-snapshot.js'
import { snapshotRunExecution } from './run-execution-snapshot.js'
import { createRunLedger } from './run-ledger.js'
import { reconcileRun, reconnectRun } from './run-replay.js'
import { isTerminal, waitForIdle } from './run-status.js'
import { shutdownApplication } from './shutdown-controller.js'

export type { SendInput, SendReceipt } from './application-types.js'
export { AppError } from './errors.js'

import {
  type ApplicationJournal,
  admitPersistedSend,
  isEffectStorage,
  reconcileRestartRun,
  restoreApplicationOperations,
} from './application-support.js'
import {
  commitEvent,
  commitEventAndWait,
  commitEventAndWaitRecovery,
  commitEventRecovery,
  type TransitionHost,
} from './application-transition.js'
import {
  type ConfigurationActionTransition,
  createConfigurationActionTransition,
} from './configuration-action-transition.js'
import { createInMemoryOperationFingerprint } from './operation-fingerprint.js'
import { RuntimeSelection } from './runtime-selection.js'

export type { BraidApplicationOptions, CancelInput, CancelReceipt } from './application-options.js'

const MAX_MESSAGE_BYTES = 1024 * 1024
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000

export class BraidApplication {
  readonly conversations: ConversationActions
  readonly intelligence: IntelligenceActions
  readonly automation: AutomationActions
  readonly configuration: ConfigurationActionTransition
  readonly runtimeSelection: RuntimeSelection
  readonly #execution: ExecutionPort
  readonly #executionProfile: Readonly<AgentProfile>
  readonly #ids: IdSource
  readonly #clock: Clock
  readonly #journal: ApplicationJournal
  readonly #effects: SerializedEffectCoordinator
  readonly #lifecycle = new ApplicationLifecycle()
  readonly #ledger = createRunLedger()
  readonly #conversationOperations = new ConversationOperationCoordinator()
  readonly #interactions: ApplicationInteractionActions
  readonly #subscribers = new Set<AppSubscriber>()
  readonly #controlOwner = `braid-control-${randomUUID()}`
  readonly #cancelTimeoutMs: number
  readonly #asynchronousJournal: boolean
  readonly #portViews: PortViews
  readonly #transition: TransitionHost
  readonly #durableSender: (input: RunExecutionSnapshot) => SendReceipt
  #transitionTail: Promise<void> = Promise.resolve()
  #storageFailure: unknown
  #cleanupUncertain: string | undefined
  #restartReconciliation: Promise<void> = Promise.resolve()
  #automationReconciliation: Promise<void> = Promise.resolve()
  #state: BraidState

  constructor(options: BraidApplicationOptions) {
    this.#execution = options.execution
    this.#executionProfile = structuredClone(options.profile)
    this.runtimeSelection = new RuntimeSelection(this.#executionProfile)
    this.#ids = options.ids
    this.#clock = options.clock
    const fallback =
      options.journal === undefined && options.effectStorage === undefined
        ? new MemoryJournal(options.clock)
        : new FailClosedJournal(options.clock)
    this.#journal = options.journal ?? fallback
    this.#asynchronousJournal = this.#journal.asynchronous === true
    const effectStorage =
      options.effectStorage ?? (isEffectStorage(this.#journal) ? this.#journal : fallback)
    const fallbackFingerprint = createInMemoryOperationFingerprint()
    const fingerprint = (input: {
      readonly effectKind: string
      readonly request: unknown
    }): string =>
      (effectStorage as import('../ports/effect-storage.js').EffectStoragePort).fingerprint?.(
        input,
      ) ?? fallbackFingerprint.fingerprint(input)
    this.#effects =
      options.effectCoordinator ??
      new SerializedEffectCoordinator(effectStorage, options.clock, {
        onRecord: (record) => this.#recordEffect(record),
      })
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS

    const persisted = this.#journal.replay?.() ?? this.#journal.all()
    for (const envelope of persisted) {
      const key = providerEventKey(envelope.event)
      if (key) this.#ledger.addProviderEvent(key)
    }
    const restored = this.#journal.initialState?.()
    const baseState =
      restored ??
      initialState(this.#executionProfile, {
        ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
        ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      })
    this.#state = replayEvents(baseState, persisted)
    assertBraidState(this.#state)
    this.runtimeSelection.syncFromState(this.#state)
    this.#interactions = new ApplicationInteractionActions({
      state: () => this.#state,
      events: () => this.#journal.all(),
      commitAndWait: (event) => {
        if (this.#asynchronousJournal) return this.#commitAndWait(event)
        this.#commit(event)
        return undefined
      },
      now: () => this.#clock.now(),
      execution: this.#execution,
      ledger: this.#ledger,
      effects: this.#effects,
      owner: this.#controlOwner,
      ports: () => this.#portViews,
      whenDurable: () => this.whenDurable(),
      ...(options.interactionResponseTimeoutMs === undefined
        ? {}
        : { responseTimeoutMs: options.interactionResponseTimeoutMs }),
    })
    this.automation = this.#interactions.automation
    const runtime = wireApplicationRuntime({
      currentState: () => this.#state,
      setState: (state) => {
        this.#state = state
      },
      profile: () => this.runtimeSelection.profile(),
      commit: (event) => this.#commit(event),
      commitAndWait: (event) => {
        if (this.#asynchronousJournal) return this.#commitAndWait(event)
        this.#commit(event)
        return undefined
      },
      commitAndWaitRecovery: (event) => {
        if (this.#asynchronousJournal) return this.#commitAndWaitRecovery(event)
        commitEventRecovery(this.#transition, event)
        return undefined
      },
      execution: this.#execution,
      ledger: this.#ledger,
      clock: this.#clock,
      ids: this.#ids,
      effects: this.#effects,
      journal: this.#journal,
      subscribers: this.#subscribers,
      asynchronousJournal: this.#asynchronousJournal,
      transitionTail: () => this.#transitionTail,
      setTransitionTail: (tail) => {
        this.#transitionTail = tail
      },
      storageFailure: () => this.#storageFailure,
      markStorageFailure: (error) => {
        this.#storageFailure ??= error
      },
      flush: () => this.whenDurable(),
      executeControl: (input, options) => this.#executeControl(input, options),
      admitPersistedSend: (operationId, digest) =>
        admitPersistedSend({
          effects: this.#effects,
          operations: this.#ledger,
          state: () => this.#state,
          operationId,
          digest,
        }),
      fingerprint,
      send: (input) => this.send(input),
      afterRuntimeEvent: (envelope, result) =>
        this.#interactions.acceptRuntimeEvent(envelope, result),
    })
    this.#portViews = runtime.ports
    this.#transition = runtime.transition
    this.configuration = createConfigurationActionTransition(this.#transition)
    this.intelligence = createIntelligenceActions(
      {
        currentState: () => this.#state,
        eventHistory: () => this.#journal.all(),
        loadEventHistory: (source) =>
          source.runId === undefined || this.#journal.loadEvents === undefined
            ? Promise.resolve(this.#journal.all())
            : this.#journal.loadEvents({ runId: source.runId }),
        commit: (event) => this.#commit(event),
        commitAndWait: (event) => {
          if (this.#asynchronousJournal) return this.#commitAndWait(event)
          this.#commit(event)
          return undefined
        },
        now: () => this.#clock.now(),
        analysisExecutionTarget: (state) => {
          const profile = this.runtimeSelection.profile()
          const profileDigest = canonicalAgentProfileDigestHex(profile)
          const selectedProfile =
            state.selectedProfileId === null
              ? undefined
              : state.profiles.find(
                  (candidate) =>
                    candidate.id === state.selectedProfileId &&
                    String(candidate.executionDigest ?? candidate.digest) === profileDigest,
                )
          const connectionId = this.runtimeSelection.connectionId()
          const connection = state.connections.find(
            (candidate) => String(candidate.id) === connectionId,
          )
          return snapshotAnalysisExecutionTarget({
            profile,
            ...(selectedProfile === undefined ? {} : { profileId: selectedProfile.id }),
            ...(connection === undefined ? {} : { connection }),
          })
        },
      },
      options.intelligence,
    )
    this.conversations = createConversationActions({
      state: () => this.#state,
      now: () => this.#clock.now(),
      commit: async (event) => {
        if (this.#asynchronousJournal) await this.#commitAndWait(event)
        else this.#commit(event)
      },
      coordinate: (input, action) =>
        this.#conversationOperations.run(input.operationId, input.digest, action),
      ...(options.conversationStorage === undefined
        ? {}
        : { storage: options.conversationStorage }),
    })
    restoreApplicationOperations(persisted, {
      state: () => this.#state,
      ledger: this.#ledger,
    })
    const runReconciliation = reconcileRestartRun(this.#portViews.restart)
    this.#restartReconciliation = runReconciliation
      .then(() => this.conversations.lifecycle.reconcilePendingDeletes())
      .catch((error: unknown) => {
        this.#storageFailure ??= error
        throw error
      })
    this.#automationReconciliation = this.#restartReconciliation.then(() =>
      this.#interactions.reconcile(),
    )
    this.#durableSender = createDurableSender({
      currentState: () => this.#state,
      ids: this.#ids,
      restartReconciliation: this.#restartReconciliation,
      transitionTail: () => this.#transitionTail,
      admitPersistedSend: (operationId, digest) =>
        admitPersistedSend({
          effects: this.#effects,
          operations: this.#ledger,
          state: () => this.#state,
          operationId,
          digest,
        }),
      requestDigest: (_state, value) =>
        fingerprint({ effectKind: 'run.execute', request: runEffectRequest(value) }),
      registerAdmission: (runId) => this.#lifecycle.registerAdmission(runId),
      sendAsync: (value, ids, signal) =>
        sendRunAsync(this.#portViews.asyncAdmission, value, ids, signal),
    })
  }

  state(): BraidState {
    return structuredClone(this.#state)
  }

  revision(): number {
    return this.#state.revision
  }

  events(): readonly BraidEventEnvelope[] {
    return this.#journal.all()
  }

  storageFailure(): string | undefined {
    if (this.#storageFailure === undefined) return undefined
    return this.#storageFailure instanceof Error ? this.#storageFailure.message : 'Storage failure'
  }

  cleanupUncertain(): string | undefined {
    return this.#cleanupUncertain
  }

  markCleanupUncertain(reason: string): void {
    this.#cleanupUncertain = redactSensitiveText(reason).slice(0, 512)
    const runId = this.#state.activeRunId
    if (runId) this.#ledger.getAbort(runId)?.abort(new Error('Cleanup deadline exceeded'))
  }

  async whenDurable(): Promise<void> {
    await this.#restartReconciliation
    await this.#transitionTail
    await this.#journal.flush?.()
    if (this.#storageFailure !== undefined) throw this.#storageFailure
  }

  subscribe(subscriber: AppSubscriber): () => void {
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }

  initialize(workspace: string): BraidState {
    if (!workspace) throw new AppError('INVALID_WORKSPACE', 'Workspace must not be empty')
    if (this.#state.workspace === workspace) return this.state()
    if (this.#state.workspace !== null)
      throw new AppError('ALREADY_INITIALIZED', 'Braid is already initialized')
    this.#commit({ kind: 'workspace.opened', workspace })
    return this.state()
  }

  send(input: SendInput): SendReceipt {
    this.#assertAdmissionOpen()
    assertWritable(this.#storageFailure)
    operationId(input.operationId, 'send')
    if (Buffer.byteLength(input.text, 'utf8') > MAX_MESSAGE_BYTES)
      throw new AppError('MESSAGE_TOO_LARGE', 'Message must not exceed 1 MiB')
    if (!input.text.trim()) throw new AppError('EMPTY_MESSAGE', 'Message must not be empty')
    const configuration = effectiveRunConfiguration(
      this.#state,
      this.runtimeSelection.profile(),
      input,
    )
    const snapshot = snapshotRunExecution(
      input,
      this.#state,
      configuration.profile,
      configuration.connectionId,
    )
    validateNativeProof(this.#portViews.admission, snapshot)
    if (this.#asynchronousJournal || admissionIsAsync(this.#execution)) {
      assertWritable(this.#storageFailure)
      const receipt = this.#durableSender(snapshot)
      this.#trackOperation(receipt)
      return receipt
    }
    try {
      const receipt = sendRun(this.#portViews.admission, snapshot)
      this.#trackOperation(receipt)
      return receipt
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'ASYNC_ADMISSION_REQUIRED') throw error
      const receipt = this.#durableSender(snapshot)
      this.#trackOperation(receipt)
      return receipt
    }
  }

  queueInput(input: {
    readonly operationId: string
    readonly text: string
    readonly runId?: string
  }): QueueReceipt {
    return queueRunInput(this.#portViews.queue, {
      ...input,
      operationId: operationId(input.operationId, 'queue'),
    })
  }

  async steer(input: {
    readonly operationId: string
    readonly runId?: string
    readonly text: string
  }): Promise<ControlReceipt> {
    return steerRun(this.#portViews.control, {
      ...input,
      operationId: operationId(input.operationId, 'steer'),
    })
  }

  async cancelRun(input: {
    readonly operationId: string
    readonly runId?: string
    readonly reason?: string
    readonly terminalStatus?: 'cancelled' | 'aborted'
    readonly legacy?: boolean
  }): Promise<ControlReceipt> {
    return cancelRun(this.#portViews.control, {
      ...input,
      operationId: operationId(input.operationId, 'cancel'),
    })
  }

  cancel(input: CancelInput): CancelReceipt {
    return legacyCancel(
      {
        state: () => this.#state,
        snapshot: () => this.state(),
        ledger: this.#ledger,
        cancelRun: (value) => this.cancelRun(value),
      },
      input,
    )
  }

  cancelActive(): boolean {
    if (!this.canCancel()) return false
    const runId = this.#state.activeRunId
    if (!runId) return false
    try {
      this.cancel({ operationId: this.#ids.next('operation'), runId })
      return true
    } catch {
      return false
    }
  }

  canCancel(): boolean {
    const runId = this.#state.activeRunId
    const run = runId ? this.#state.runs.find((candidate) => candidate.id === runId) : undefined
    const abort = runId ? this.#ledger.getAbort(runId) : undefined
    return Boolean(
      run &&
        !isTerminal(run.status) &&
        run.status !== 'cancelling' &&
        run.capabilities.controls.cancel &&
        abort &&
        this.#ledger.controlForRun(run.id, 'cancel') === undefined,
    )
  }

  canRespondToInteractions(runId?: string): boolean {
    return this.#interactions.canRespond(runId)
  }

  async detachRun(input: {
    readonly operationId: string
    readonly runId?: string
  }): Promise<ControlReceipt> {
    return detachRun(this.#portViews.control, {
      ...input,
      operationId: operationId(input.operationId, 'detach'),
    })
  }

  async respondInteraction(input: {
    readonly operationId: string
    readonly runId: string
    readonly interactionId: string
    readonly response: InteractionResponse
  }): Promise<InteractionReceipt> {
    return this.#interactions.respond({
      ...input,
      operationId: operationId(input.operationId, 'respond-interaction'),
    })
  }

  async #executeControl(
    input: ControlEffectRequest,
    options: import('./application-ports.js').ControlDispatchOptions = {},
  ): Promise<import('../ports/execution.js').ControlAcknowledgement> {
    return executeControlEffect({
      effects: this.#effects,
      execution: this.#execution,
      request: input,
      owner: this.#controlOwner,
      timeoutMs: this.#cancelTimeoutMs,
      whenDurable: () => this.whenDurable(),
      canSettleLate: () => !this.#lifecycle.isClosed(),
      onLateSettlement: options.onLateSettlement,
    })
  }

  async reconnectRun(input: ReconnectInput): Promise<BraidState> {
    return reconnectRun(this.#portViews.replay, input)
  }

  async reconcileRun(input: ReconnectInput): Promise<BraidState> {
    return reconcileRun(this.#portViews.replay, input)
  }

  async continueNative(input: {
    readonly operationId: string
    readonly text: string
    readonly runId?: string
  }): Promise<SendReceipt> {
    return continueNative(this.#portViews.nativeContinuation, {
      ...input,
      operationId: operationId(input.operationId, 'continue'),
    })
  }

  shutdown(input: {
    readonly operationId: string
    readonly mode?: 'wait' | 'detach' | 'cancel'
  }): ShutdownReceipt {
    const opId = operationId(input.operationId, 'shutdown')
    return shutdownApplication({
      operationId: opId,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      state: () => this.#state,
      ledger: this.#ledger,
      commit: (event) => this.#commit(event),
      cancelRun: (value) => this.cancelRun(value),
      detachRun: (value) => this.detachRun(value),
      waitForIdle: () => this.waitForIdle(),
    })
  }

  async waitForIdle(): Promise<BraidState> {
    return waitForIdle(this.#portViews.status)
  }

  close(): Promise<void> {
    return this.#lifecycle.close(() => this.#closeStorage())
  }

  async #closeStorage(): Promise<void> {
    let failure: unknown
    try {
      await this.#lifecycle.settleActive({
        runIds: this.#activeRunIds(),
        timeoutMs: this.#cancelTimeoutMs,
        cancel: (runId) => this.#cancelForClose(runId),
        markUnknown: (runId) => this.#markRunUnknownAfterCloseDeadline(runId),
      })
      await this.#automationReconciliation
      await this.#interactions.whenIdle()
      await this.whenDurable()
    } catch (error) {
      failure = error
    } finally {
      await this.#journal.close?.()
    }
    if (failure !== undefined) throw failure
  }

  ingestRuntimeEvent(envelope: RuntimeEventEnvelope): RuntimeEventIngestionResult {
    return this.#portViews.ingestion.ingestRuntimeEvent(envelope) as RuntimeEventIngestionResult
  }

  admit(
    input: ExecuteTurnInput,
    conversationId: string,
    branchId: string,
    contextTransfer?: ContextTransferReceipt,
    turnId?: string,
    contextPlanDigest?: string,
    nativeContextBoundaryProof?: NativeContextBoundaryProof,
  ): RunAdmissionReceipt {
    this.#assertAdmissionOpen()
    return admitRun(
      this.#portViews.admission,
      { ...input, operationId: operationId(input.operationId, 'admit') },
      conversationId,
      branchId,
      contextTransfer,
      turnId,
      contextPlanDigest,
      nativeContextBoundaryProof,
    )
  }

  #recordEffect(record: import('../ports/effect-storage.js').EffectRecord): void {
    this.#commit({ kind: 'effect.upserted', effect: projectEffectRecord(record) })
  }

  #commit(event: BraidEvent): void {
    this.#assertNotClosed()
    commitEvent(this.#transition, event)
  }

  #commitAndWait(event: BraidEvent): Promise<void> {
    this.#assertNotClosed()
    return commitEventAndWait(this.#transition, event)
  }

  #commitAndWaitRecovery(event: BraidEvent): Promise<void> {
    if (this.#lifecycle.isClosed()) return Promise.resolve()
    return commitEventAndWaitRecovery(this.#transition, event)
  }

  #assertAdmissionOpen(): void {
    if (!this.#lifecycle.acceptsAdmission())
      throw new AppError('APPLICATION_CLOSING', 'Braid is closing and cannot admit a new run')
  }

  #assertNotClosed(): void {
    if (this.#lifecycle.isClosed())
      throw new AppError('APPLICATION_CLOSED', 'Braid is closed and cannot commit events')
  }

  #trackOperation(receipt: SendReceipt): void {
    this.#lifecycle.track({ runId: receipt.runId, completion: receipt.completion })
  }

  #activeRunIds(): readonly string[] {
    const active = this.#lifecycle.activeOperations().map((operation) => operation.runId)
    const current = this.#state.activeRunId
    return current === null ? active : [...active, current]
  }

  async #cancelForClose(runId: string): Promise<void> {
    const run = this.#state.runs.find((candidate) => candidate.id === runId)
    if (run === undefined || isTerminal(run.status)) return
    const receipt = await this.cancelRun({
      operationId: `operation-close-${runId}`,
      runId,
      reason: 'Braid is shutting down',
      terminalStatus: 'aborted',
      legacy: true,
    })
    await receipt.completion
  }

  async #markRunUnknownAfterCloseDeadline(runId: string): Promise<void> {
    this.#ledger.getAbort(runId)?.abort(new Error('Application close deadline exceeded'))
    const run = this.#state.runs.find((candidate) => candidate.id === runId)
    if (run === undefined || isTerminal(run.status)) return
    await this.#commitAndWaitRecovery({
      kind: 'run.unknown',
      runId,
      detail: 'Application close deadline exceeded before the run settled',
    })
  }
}
