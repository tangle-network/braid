import type { AgentProfile } from '@tangle-network/agent-interface'
import type { BraidEventEnvelope } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import type { AnalysisCommand } from '../analysis/commands.js'
import type { AnalysisCommandResult } from '../analysis/command-path.js'
import type { AnalysisService } from '../analysis/service.js'
import type { AnalysisSourcePort } from '../analysis/source.js'
import type { AnalysisRecord } from '../analysis/model.js'
import type { ApplicationEvaluationInput, ApplicationEvaluationResult } from './evaluation-route.js'
import type { W11Judge } from '../evaluation/w11-runner.js'
import type { CancellationCommand, RuntimeSupervisorPort } from '../supervisor/runtime-supervisor.js'
import { toJsonValue } from '../analysis/serialization.js'
import { APPLICATION_SOURCE_ID } from './analysis-source.js'
import { ApplicationAnalysisService } from './application-analysis.js'
import { ApplicationComparisonService, type ApplicationComparison } from './application-comparison.js'
import { ApplicationEvaluationService } from './application-evaluation.js'
import { ApplicationGraphService } from './application-graph.js'
import { ApplicationReceiptService } from './application-receipts.js'
import { ApplicationRunService, type ApplicationRunCancellationReceipt, type SendInput, type SendReceipt } from './application-run.js'
import { ApplicationStateStore, type ApplicationStateSubscriber } from './application-state.js'
import { ApplicationSupervisorService, type ApplicationWorkerCancellationReceipt } from './application-supervisor.js'

export type AppSubscriber = ApplicationStateSubscriber
export type {
  ApplicationRunCancellationReceipt as ApplicationCancellationReceipt,
  SendInput,
  SendReceipt,
} from './application-run.js'
export type { ApplicationWorkerCancellationReceipt } from './application-supervisor.js'
export type { ApplicationComparison }

export { AppError } from './errors.js'

/** Stable application aggregate; domain work lives in the composed services. */
export class BraidApplication {
  readonly #state: ApplicationStateStore
  readonly #runs: ApplicationRunService
  readonly #analysis: ApplicationAnalysisService
  readonly #evaluation: ApplicationEvaluationService
  readonly #comparison: ApplicationComparisonService
  readonly #graph: ApplicationGraphService
  readonly #supervisor: ApplicationSupervisorService

  constructor(options: {
    readonly profile: Readonly<AgentProfile>
    readonly execution: ExecutionPort
    readonly clock: Clock
    readonly ids: IdSource
    readonly analysis?: AnalysisService
    readonly analysisSource?: AnalysisSourcePort
    readonly analysisSourceId?: () => string
    readonly supervisor?: RuntimeSupervisorPort
  }) {
    this.#state = new ApplicationStateStore(options.profile, options.clock)
    const receipts = new ApplicationReceiptService({
      commitReceipt: (operationId, targetId, receipt) =>
        this.#state.commit({
          kind: 'operation.receipt',
          operationId,
          targetId,
          receipt: toJsonValue(receipt),
        }),
    })
    this.#runs = new ApplicationRunService({
      state: this.#state,
      execution: options.execution,
      ids: options.ids,
      receipts,
    })
    this.#analysis = new ApplicationAnalysisService({
      service: options.analysis,
      sourceId: options.analysisSourceId ?? (() => APPLICATION_SOURCE_ID),
    })
    this.#evaluation = new ApplicationEvaluationService(options.analysis)
    this.#comparison = new ApplicationComparisonService({
      readAnalysisSource: () => options.analysisSource,
      receipts,
    })
    this.#graph = new ApplicationGraphService(this.#state)
    this.#supervisor = new ApplicationSupervisorService({
      supervisor: options.supervisor,
      receipts,
    })
  }

  state(): BraidState {
    return this.#state.state()
  }

  events(): readonly BraidEventEnvelope[] {
    return this.#state.events()
  }

  analysisRunId(): string | undefined {
    return this.#runs.analysisRunId()
  }

  analysisTraces() {
    return this.#runs.analysisTraces()
  }

  subscribe(subscriber: AppSubscriber): () => void {
    return this.#state.subscribe(subscriber)
  }

  initialize(workspace: string): BraidState {
    return this.#state.initialize(workspace)
  }

  send(input: SendInput): SendReceipt {
    return this.#runs.send(input)
  }

  cancelActive(): boolean {
    return this.#runs.cancelActive()
  }

  cancelRun(input: {
    readonly operationId: string
    readonly runId: string
    readonly reason: string
  }): ApplicationRunCancellationReceipt {
    return this.#runs.cancelRun(input)
  }

  graph() {
    return this.#graph.graph()
  }

  supervisorSnapshot(supervisorId: string) {
    return this.#supervisor.snapshot(supervisorId)
  }

  cancelWorker(command: CancellationCommand): Promise<ApplicationWorkerCancellationReceipt> {
    return this.#supervisor.cancelWorker(command)
  }

  compare(input: Parameters<ApplicationComparisonService['compare']>[0]) {
    return this.#comparison.compare(input)
  }

  compareSources(input: Parameters<ApplicationComparisonService['compareSources']>[0]) {
    return this.#comparison.compareSources(input)
  }

  evaluateAnalysis(
    record: AnalysisRecord,
    judge: W11Judge,
    evaluationInputs: readonly ApplicationEvaluationInput[],
  ): Promise<ApplicationEvaluationResult> {
    return this.#evaluation.evaluate(record, judge, evaluationInputs)
  }

  executeAnalysisCommand(
    command: AnalysisCommand,
    operationId: string,
  ): Promise<AnalysisCommandResult> {
    return this.#analysis.execute(command, operationId)
  }

  waitForIdle(): Promise<BraidState> {
    return this.#runs.waitForIdle()
  }
}
