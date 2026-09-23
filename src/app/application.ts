import type { AgentProfile } from '@tangle-network/agent-interface'
import { InteractionController } from '../controllers/interaction-controller.js'
import type {
  AutomationDryRunInput,
  AutomationDryRunResult,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from '../controllers/interaction-controller-types.js'
import { boundedText, MAX_TEXT_BYTES, utf8Bytes } from '../domain/bounds.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEventEnvelope } from '../domain/events.js'
import type { AutomationRuleRecord } from '../domain/interaction-state.js'
import { redactedProfile, sensitiveProfileValues } from '../domain/profile.js'
import { initialState, type BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import type { Scheduler } from '../ports/scheduler.js'
import type {
  CancelInteractionInput,
  InteractionReceiveResult,
  InteractionResponseResult,
  InteractionRuntimePort,
  ReceiveInteractionInput,
  RespondInteractionInput,
} from '../ports/interactions.js'
import { UnavailableInteractionRuntime } from '../adapters/runtime/unavailable-interaction-runtime.js'
import { AppError } from './errors.js'
import { ApplicationStateStore, type AppSubscriber } from './application-state.js'
import { RunAdmissionService, type SendInput, type SendReceipt } from './run-admission.js'
import { RunExecutionService } from './run-execution.js'
import { OperationAuthority } from '../domain/operation-authority.js'

export { AppError }
export type { AppSubscriber, SendInput, SendReceipt }

export class BraidApplication {
  readonly #clock: Clock
  readonly #state: ApplicationStateStore
  readonly #interactionController: InteractionController
  readonly #admission: RunAdmissionService

  constructor(options: {
    readonly profile: Readonly<AgentProfile>
    readonly execution: ExecutionPort
    readonly clock: Clock
    readonly ids: IdSource
    readonly interactionRuntime?: InteractionRuntimePort
    readonly feedbackCapture?: boolean
    readonly initialEvents?: readonly BraidEventEnvelope[]
    readonly journalKey?: Uint8Array
    readonly secretResponseKey?: string | Uint8Array
    readonly scheduler?: Scheduler
  }) {
    this.#clock = options.clock
    const initialEvents = options.initialEvents ?? []
    const safeProfile = redactedProfile(options.profile)
    this.#state = new ApplicationStateStore({
      initialState: initialState(safeProfile),
      clock: options.clock,
      initialEvents,
      ...(options.journalKey === undefined ? {} : { journalKey: options.journalKey }),
    })
    const operations = new OperationAuthority()
    const interactionRuntime =
      options.interactionRuntime ??
      options.execution.interactions ??
      new UnavailableInteractionRuntime()
    const state = this.#state.state()
    this.#interactionController = new InteractionController({
      runtime: interactionRuntime,
      clock: options.clock,
      ids: options.ids,
      ...(options.secretResponseKey === undefined && options.journalKey === undefined
        ? {}
        : { secretResponseKey: options.secretResponseKey ?? options.journalKey }),
      ...(options.feedbackCapture === undefined
        ? {}
        : { feedbackCapture: options.feedbackCapture }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      operationAuthority: operations,
      applicationState: this.#state,
      defaultContext: {
        profileDigest: canonicalDigest(state.profile),
        conversationId: state.conversationId,
        branchId: state.branchId,
        ...(state.profile.model?.default === undefined
          ? {}
          : { model: state.profile.model.default }),
        ...(typeof state.profile.harness === 'string' ? { runner: state.profile.harness } : {}),
      },
    })
    const execution = new RunExecutionService({
      execution: options.execution,
      profile: structuredClone(options.profile),
      protectedValues: sensitiveProfileValues(options.profile),
      state: this.#state,
      receiveQuestion: (input) => this.#interactionController.receive(input),
    })
    this.#admission = new RunAdmissionService({
      state: this.#state,
      ids: options.ids,
      operations,
      execution,
    })
    this.#admission.rehydrate(initialEvents)
  }

  state(): BraidState {
    return this.#state.state()
  }

  events(): readonly BraidEventEnvelope[] {
    return this.#state.events()
  }

  now(): string {
    return this.#clock.now()
  }

  subscribe(subscriber: AppSubscriber): () => void {
    return this.#state.subscribe(subscriber)
  }

  interactionController(): InteractionController {
    return this.#interactionController
  }

  interactionCapabilities(): InteractionRuntimePort['capabilities'] {
    return this.#interactionController.capabilities()
  }

  receiveInteraction(input: ReceiveInteractionInput): InteractionReceiveResult & {
    readonly automation: Promise<InteractionResponseResult | undefined>
  } {
    return this.#interactionController.receive(input)
  }

  respondInteraction(input: RespondInteractionInput): Promise<InteractionResponseResult> {
    return this.#interactionController.respond(input)
  }

  cancelInteraction(input: CancelInteractionInput): Promise<InteractionResponseResult> {
    return this.#interactionController.cancel(input)
  }

  createAutomationRule(input: CreateAutomationRuleInput): AutomationRuleRecord {
    return this.#interactionController.createAutomationRule(input)
  }

  updateAutomationRule(input: UpdateAutomationRuleInput): AutomationRuleRecord {
    return this.#interactionController.updateAutomationRule(input)
  }

  dryRunAutomation(input: AutomationDryRunInput): Promise<AutomationDryRunResult> {
    return this.#interactionController.dryRun(input)
  }

  disableAutomationRule(operationId: string, ruleId: string): boolean {
    return this.#interactionController.disableAutomationRule(operationId, ruleId)
  }

  deleteAutomationRule(operationId: string, ruleId: string): boolean {
    return this.#interactionController.deleteAutomationRule(operationId, ruleId)
  }

  waitForAutomation(): Promise<void> {
    return this.#interactionController.waitForAutomation()
  }

  reconcileInteractions(input?: {
    readonly runId?: string
    readonly signal?: AbortSignal
  }): Promise<void> {
    return this.#interactionController.reconcile(input)
  }

  initialize(workspace: string): BraidState {
    if (!workspace || utf8Bytes(workspace) > MAX_TEXT_BYTES) {
      throw new AppError('INVALID_WORKSPACE', 'Workspace must be a bounded non-empty string')
    }
    const state = this.#state.state()
    if (state.workspace === workspace) return state
    if (state.workspace !== null) {
      throw new AppError('ALREADY_INITIALIZED', 'Braid is already initialized')
    }
    this.#state.commit({ kind: 'workspace.opened', workspace: boundedText(workspace) })
    return this.#state.state()
  }

  send(input: SendInput): SendReceipt {
    return this.#admission.send(input)
  }

  cancelActive(): boolean {
    return this.#admission.cancelActive()
  }

  waitForIdle(): Promise<BraidState> {
    return this.#admission.waitForIdle()
  }

  shutdown(): void {
    this.#interactionController.dispose()
  }
}
