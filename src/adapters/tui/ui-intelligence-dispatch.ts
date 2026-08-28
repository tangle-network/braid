import type { AnalysisComparisonResult } from '../../app/analysis-comparison-contracts.js'
import type { AnalysisExecutionResult } from '../../app/analysis-service.js'
import { parseAnalysisSourceReference, projectAnalysisSource } from '../../app/analysis-source.js'
import type { AnalysisRequest, AnalysisSourceRequest } from '../../app/analysis-types.js'
import { AnalysisCapabilityError } from '../../app/analysis-types.js'
import type { BraidApplication } from '../../app/application.js'
import { AppError } from '../../app/errors.js'
import type { BraidState } from '../../domain/state.js'
import { capabilityForHeadlessCommand } from '../../views/shared/headless-commands.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import type { BraidViewModel } from '../../views/shared/models.js'
import { redactSensitiveText } from '../../views/shared/sanitize.js'
import type { UiFixture } from './ui-fixtures.js'
import { resolveIntelligenceFixture } from './ui-intelligence-fixtures.js'

interface IntelligenceDispatchContext {
  readonly app: BraidApplication
  readonly fixture: UiFixture | undefined
  readonly view: () => BraidViewModel
  readonly notify: () => void
  readonly setNotice: (notice: string) => void
}

type AnalysisCommand = 'ask' | 'analyze' | 'compare'

type AnalysisTerminal =
  | {
      readonly status: 'completed'
      readonly analysis: AnalysisExecutionResult['analysis']
      readonly evidence: AnalysisExecutionResult['evidence']
    }
  | {
      readonly status: 'failed'
      readonly analysis: AnalysisExecutionResult['analysis']
      readonly evidence: AnalysisExecutionResult['evidence']
      readonly error: Error
    }
  | {
      readonly status: 'cancelled'
      readonly analysis: AnalysisExecutionResult['analysis']
      readonly evidence: AnalysisExecutionResult['evidence']
      readonly reason?: string
    }

function requiresOperationId(intent: BraidIntent): boolean {
  if (intent.type === 'run-command') {
    return intent.command === 'ask' || intent.command === 'analyze' || intent.command === 'compare'
  }
  if (intent.type !== 'headless-command') return false
  return (
    intent.command === 'ask' ||
    intent.command === 'analyze' ||
    intent.command === 'compare' ||
    intent.command === 'promote_analysis' ||
    intent.command === 'cancel_analysis' ||
    intent.command === 'reconnect' ||
    intent.command === 'steer_worker' ||
    intent.command === 'cancel_worker' ||
    intent.command === 'cancel_supervisor' ||
    intent.command === 'attach_worker'
  )
}

function isIntelligenceHeadlessCommand(command: string): boolean {
  return [
    'ask',
    'analyze',
    'compare',
    'promote_analysis',
    'cancel_analysis',
    'reconnect',
    'refresh_supervision',
    'steer_worker',
    'cancel_worker',
    'cancel_supervisor',
    'attach_worker',
  ].includes(command)
}

function accepted(app: BraidApplication, data: unknown, operationId?: string): UiDispatchResult {
  return {
    kind: 'accepted',
    revision: app.state().revision,
    ...(operationId === undefined ? {} : { operationId }),
    data,
  }
}

function storedComparisonData(
  state: BraidState,
  operationId: string,
  result: AnalysisComparisonResult,
): AnalysisComparisonResult & { readonly analysisId: string } {
  const record = state.analyses.find(
    (analysis) => analysis.kind === 'comparison' && analysis.operationId === operationId,
  )
  if (record === undefined) throw new Error('The stored comparison record is unavailable')
  return { ...result, analysisId: String(record.id) }
}

function unavailable(reason: string): UiDispatchResult {
  return {
    kind: 'unavailable',
    code: 'CAPABILITY_UNAVAILABLE',
    reason: redactSensitiveText(reason),
  }
}

function invalid(code: string, message: string): never {
  throw new AppError(code, message)
}

function sourceRequest(state: BraidState, reference: string): AnalysisSourceRequest {
  const value = reference.trim()
  if (!value) invalid('ANALYSIS_SOURCE_INVALID', 'Analysis source must not be empty')
  const projection = projectAnalysisSource(state, value)
  if (projection !== undefined) return projection.request
  if (value === 'active' || value === 'last') {
    invalid(
      'ANALYSIS_SOURCE_MISSING',
      'No completed or failed run is available on the selected branch',
    )
  }

  invalid('ANALYSIS_SOURCE_UNKNOWN', `Analysis source '${value}' is not present in Braid state`)
}

function issueReason(issue: {
  readonly capability: string
  readonly packageName: string
  readonly packageVersion: string
  readonly reason: string
}): string {
  return `${issue.capability} unavailable in ${issue.packageName}@${issue.packageVersion}: ${issue.reason}`
}

function analysisData(terminal: AnalysisTerminal) {
  const data = {
    status: terminal.status,
    analysis: terminal.analysis,
    source: {
      digest: terminal.evidence.source.digest,
      conversationId: terminal.evidence.source.conversationId,
      branchId: terminal.evidence.source.branchId,
      ...(terminal.evidence.source.runId === undefined
        ? {}
        : { runId: terminal.evidence.source.runId }),
      complete: terminal.evidence.source.complete,
      eventCount: terminal.evidence.events.length,
      messageCount: terminal.evidence.messages.length,
      messagePartCount: terminal.evidence.messageParts.length,
    },
  }
  if (terminal.status === 'failed') {
    return { ...data, error: redactSensitiveText(terminal.error.message) }
  }
  if (terminal.status === 'cancelled' && terminal.reason !== undefined) {
    return { ...data, reason: redactSensitiveText(terminal.reason) }
  }
  return data
}

async function runAnalysis(
  context: IntelligenceDispatchContext,
  request: AnalysisRequest,
  operationId?: string,
): Promise<UiDispatchResult> {
  let terminal: AnalysisTerminal | undefined
  for await (const progress of context.app.intelligence.analysis.stream(request)) {
    context.notify()
    if (progress.type === 'completed') {
      terminal = {
        status: 'completed',
        analysis: progress.analysis,
        evidence: progress.evidence,
      }
    } else if (progress.type === 'failed') {
      terminal = {
        status: 'failed',
        analysis: progress.analysis,
        evidence: progress.evidence,
        error: progress.error,
      }
    } else if (progress.type === 'cancelled') {
      terminal = {
        status: 'cancelled',
        analysis: progress.analysis,
        evidence: progress.evidence,
        ...(progress.reason === undefined ? {} : { reason: progress.reason }),
      }
    }
  }
  if (terminal === undefined) throw new Error('Analysis stream ended without a final result')
  if (terminal.status === 'failed' && terminal.error instanceof AnalysisCapabilityError) {
    return unavailable(issueReason(terminal.error.issue))
  }
  const data = analysisData(terminal)
  const notice =
    terminal.status === 'completed'
      ? `Analysis complete: ${terminal.analysis.findings.length} cited finding(s)`
      : `Analysis ${terminal.status}: ${terminal.analysis.id}`
  context.setNotice(notice)
  return accepted(context.app, data, operationId)
}

function analysisRequestForCommand(
  state: BraidState,
  command: AnalysisCommand,
  args: readonly string[],
): { readonly request: AnalysisRequest } {
  if (command === 'ask') {
    const explicitSource =
      args[0] !== undefined && parseAnalysisSourceReference(args[0]) !== undefined
    const source = explicitSource
      ? sourceRequest(state, args[0] ?? '')
      : sourceRequest(state, 'last')
    const question = (explicitSource ? args.slice(1) : args).join(' ').trim()
    if (!question) invalid('INVALID_PARAMS', '/ask requires a question')
    return { request: { ...source, question, recipe: 'ask' } }
  }
  if (command === 'analyze') {
    const recipe = args
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean)
      .join(',')
    if (!recipe) invalid('INVALID_PARAMS', '/analyze requires a named recipe or all')
    return { request: { ...sourceRequest(state, 'last'), recipe } }
  }
  invalid('INVALID_PARAMS', '/compare requires two source references')
}

function supervisorRoot(state: BraidState): { readonly rootDir: string } | undefined {
  if (state.workspace === null) return undefined
  return { rootDir: state.workspace }
}

function supervisorData(
  projection: Awaited<ReturnType<BraidApplication['intelligence']['supervisor']['snapshot']>>,
) {
  return {
    supervisors: projection.supervisors,
    workers: projection.workers,
    graphNodes: projection.graphNodes,
    graphEdges: projection.graphEdges,
  }
}

async function dispatchSupervisorQuery(
  command: 'snapshot' | 'reconnect',
  context: IntelligenceDispatchContext,
): Promise<UiDispatchResult> {
  const root = supervisorRoot(context.app.state())
  if (root === undefined) {
    return unavailable('Supervisor snapshots require an initialized workspace')
  }
  try {
    const hadSavedSupervision =
      context.app.state().supervisors.length > 0 || context.app.state().workers.length > 0
    const projection =
      command === 'snapshot'
        ? await context.app.intelligence.supervisor.snapshot(root)
        : await context.app.intelligence.supervisor.reconnect(root)
    if (projection.raw.supervisors.length === 0 && hadSavedSupervision) {
      return unavailable('The runtime returned no supervisor snapshot for this workspace')
    }
    return accepted(context.app, supervisorData(projection))
  } catch (error) {
    return unavailable(
      `Supervisor ${command} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function runtimeWorkerReference(
  state: BraidState,
  supervisorId: string,
  workerId: string,
):
  | {
      readonly rootDir: string
      readonly runtimeSupervisorId: string
      readonly runtimeWorkerId: string
    }
  | undefined {
  const supervisor = state.supervisors.find((candidate) => String(candidate.id) === supervisorId)
  if (supervisor === undefined || state.workspace !== supervisor.runtimeRoot) return undefined
  const worker = state.workers.find(
    (candidate) => String(candidate.id) === workerId && candidate.supervisorId === supervisor.id,
  )
  if (worker === undefined) return undefined
  return {
    rootDir: supervisor.runtimeRoot,
    runtimeSupervisorId: supervisor.runtimeId,
    runtimeWorkerId: worker.runtimeId,
  }
}

function runtimeSupervisorReference(
  state: BraidState,
  supervisorId: string,
): { readonly rootDir: string; readonly runtimeSupervisorId: string } | undefined {
  const supervisor = state.supervisors.find((candidate) => String(candidate.id) === supervisorId)
  if (supervisor === undefined || state.workspace !== supervisor.runtimeRoot) return undefined
  return { rootDir: supervisor.runtimeRoot, runtimeSupervisorId: supervisor.runtimeId }
}

async function dispatchSupervisorWorker(
  command: 'steer_worker' | 'cancel_worker',
  context: IntelligenceDispatchContext,
  params: Readonly<Record<string, unknown>>,
  operationId?: string,
): Promise<UiDispatchResult> {
  const workerId = params.workerId
  if (typeof workerId !== 'string') invalid('INVALID_PARAMS', `${command} requires workerId`)
  const supervisorId = params.supervisorId
  if (typeof supervisorId !== 'string') {
    invalid('INVALID_PARAMS', `${command} requires supervisorId and workerId`)
  }
  const reference = runtimeWorkerReference(context.app.state(), supervisorId, workerId)
  if (reference === undefined) {
    return unavailable('The selected worker is not present under the selected supervisor')
  }
  if (command === 'cancel_worker') {
    if (operationId === undefined)
      invalid('OPERATION_ID_REQUIRED', 'cancel_worker requires operationId')
    const reason = typeof params.reason === 'string' ? params.reason : undefined
    try {
      const result = await context.app.intelligence.supervisor.cancelWorker(
        reference.rootDir,
        reference.runtimeSupervisorId,
        reference.runtimeWorkerId,
        operationId,
        reason,
      )
      if (result.status === 'unavailable') {
        return unavailable(
          result.issue === undefined
            ? 'Worker cancellation is unavailable'
            : issueReason(result.issue),
        )
      }
      context.setNotice(
        result.effect === 'cancelled'
          ? `Worker cancellation confirmed: ${workerId}`
          : `Worker cancellation ${result.effect ?? 'requested'}: ${workerId}`,
      )
      return accepted(context.app, { ...result, worker: workerId }, operationId)
    } catch (error) {
      return unavailable(
        `Worker cancellation is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const text = params.text
  if (typeof text !== 'string') {
    invalid('INVALID_PARAMS', 'steer_worker requires supervisorId, workerId, and text')
  }
  if (operationId === undefined)
    invalid('OPERATION_ID_REQUIRED', 'steer_worker requires operationId')
  try {
    const result = await context.app.intelligence.supervisor.steerWorker(
      reference.rootDir,
      reference.runtimeSupervisorId,
      reference.runtimeWorkerId,
      operationId,
      text,
    )
    if (result.status === 'unavailable') {
      return unavailable(
        result.issue === undefined ? 'Worker steering is unavailable' : issueReason(result.issue),
      )
    }
    return accepted(context.app, { ...result, worker: workerId }, operationId)
  } catch (error) {
    return unavailable(
      `Worker steering is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function dispatchSupervisorCancel(
  context: IntelligenceDispatchContext,
  params: Readonly<Record<string, unknown>>,
  operationId?: string,
): Promise<UiDispatchResult> {
  const supervisorId = params.supervisorId
  if (typeof supervisorId !== 'string')
    invalid('INVALID_PARAMS', 'cancel_supervisor requires supervisorId')
  if (operationId === undefined)
    invalid('OPERATION_ID_REQUIRED', 'cancel_supervisor requires operationId')
  const reference = runtimeSupervisorReference(context.app.state(), supervisorId)
  if (reference === undefined) {
    return unavailable('The selected supervisor is not present in the current workspace')
  }
  const reason = typeof params.reason === 'string' ? params.reason : undefined
  try {
    const result = await context.app.intelligence.supervisor.cancelSupervisor(
      reference.rootDir,
      reference.runtimeSupervisorId,
      operationId,
      reason,
    )
    if (result.status === 'unavailable') {
      return unavailable(
        result.issue === undefined
          ? 'Supervisor cancellation is unavailable'
          : issueReason(result.issue),
      )
    }
    context.setNotice(
      result.effect === 'cancelled'
        ? `Supervisor cancellation confirmed: ${supervisorId}`
        : `Supervisor cancellation ${result.effect ?? 'requested'}: ${supervisorId}`,
    )
    return accepted(context.app, result, operationId)
  } catch (error) {
    return unavailable(
      `Supervisor cancellation is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function dispatchIntelligenceIntent(
  intent: BraidIntent,
  context: IntelligenceDispatchContext,
): Promise<UiDispatchResult | undefined> {
  if (intent.type === 'refresh-supervision') {
    return dispatchSupervisorQuery('snapshot', context)
  }
  if (requiresOperationId(intent)) {
    const command =
      intent.type === 'run-command' || intent.type === 'headless-command'
        ? intent.command
        : 'intelligence action'
    const operationId =
      intent.type === 'run-command' || intent.type === 'headless-command'
        ? intent.operationId
        : undefined
    if (operationId === undefined)
      invalid('OPERATION_ID_REQUIRED', `${command} requires operationId`)
  }
  if (intent.type === 'headless-command' && isIntelligenceHeadlessCommand(intent.command)) {
    const capability = capabilityForHeadlessCommand(intent.command)
    const availability =
      capability === undefined ? undefined : context.view().capabilities[capability]
    if (availability !== undefined && !availability.available) {
      return unavailable(availability.reason ?? 'Capability is unavailable')
    }
  }
  const fixture = resolveIntelligenceFixture(intent, context.fixture)
  if (fixture !== undefined) {
    context.setNotice(fixture.notice)
    const operationId = intent.type === 'run-command' ? intent.operationId : undefined
    return accepted(context.app, fixture.data, operationId)
  }
  if (intent.type === 'run-command') {
    if (intent.command !== 'ask' && intent.command !== 'analyze' && intent.command !== 'compare') {
      return undefined
    }
    const state = context.app.state()
    if (intent.command === 'compare') {
      if (intent.args.length !== 2)
        invalid('INVALID_PARAMS', '/compare requires two source references')
      const operationId = intent.operationId
      if (operationId === undefined)
        invalid('OPERATION_ID_REQUIRED', 'compare requires operationId')
      const baseline = sourceRequest(state, intent.args[0] ?? '')
      const candidate = sourceRequest(state, intent.args[1] ?? '')
      const result = await context.app.intelligence.comparison.compareAndStore({
        operationId,
        baseline,
        candidate,
      })
      context.setNotice(`Comparison complete: ${result.paired.nPairs} paired run(s)`)
      return accepted(
        context.app,
        storedComparisonData(context.app.state(), operationId, result),
        operationId,
      )
    }
    const request = analysisRequestForCommand(state, intent.command, intent.args).request
    return runAnalysis(context, request, intent.operationId)
  }

  if (intent.type !== 'headless-command') return undefined
  switch (intent.command) {
    case 'ask': {
      const source = intent.params.source
      const question = intent.params.question
      if (typeof source !== 'string' || typeof question !== 'string') {
        invalid('INVALID_PARAMS', 'ask requires source and question')
      }
      return runAnalysis(
        context,
        { ...sourceRequest(context.app.state(), source), question, recipe: 'ask' },
        intent.operationId,
      )
    }
    case 'analyze': {
      const source = intent.params.source
      const recipe = intent.params.recipe
      const analystIds = intent.params.analystIds
      if (
        typeof source !== 'string' ||
        (recipe !== undefined && typeof recipe !== 'string') ||
        (analystIds !== undefined &&
          (!Array.isArray(analystIds) || !analystIds.every((id) => typeof id === 'string')))
      ) {
        invalid('INVALID_PARAMS', 'analyze requires source and a recipe or analystIds')
      }
      if (recipe === undefined && analystIds === undefined) {
        invalid('INVALID_PARAMS', 'analyze requires a recipe or analystIds')
      }
      return runAnalysis(
        context,
        {
          ...sourceRequest(context.app.state(), source),
          ...(recipe === undefined ? {} : { recipe }),
          ...(analystIds === undefined ? {} : { analystIds }),
        },
        intent.operationId,
      )
    }
    case 'compare': {
      const left = intent.params.left
      const right = intent.params.right
      if (typeof left !== 'string' || typeof right !== 'string') {
        invalid('INVALID_PARAMS', 'compare requires left and right sources')
      }
      const operationId = intent.operationId
      if (operationId === undefined)
        invalid('OPERATION_ID_REQUIRED', 'compare requires operationId')
      const result = await context.app.intelligence.comparison.compareAndStore({
        operationId,
        baseline: sourceRequest(context.app.state(), left),
        candidate: sourceRequest(context.app.state(), right),
      })
      return accepted(
        context.app,
        storedComparisonData(context.app.state(), operationId, result),
        operationId,
      )
    }
    case 'promote_analysis': {
      const analysisId = intent.params.analysisId
      const findingIds = intent.params.findingIds
      if (
        typeof analysisId !== 'string' ||
        !Array.isArray(findingIds) ||
        !findingIds.every((id) => typeof id === 'string')
      ) {
        invalid('INVALID_PARAMS', 'promote_analysis requires analysisId and findingIds')
      }
      const analysis = context.app
        .state()
        .analyses.find((candidate) => String(candidate.id) === analysisId)
      if (analysis === undefined)
        invalid('UNKNOWN_ANALYSIS', `Analysis ${analysisId} is not present`)
      const state = context.app.state()
      const destinationConversationId =
        typeof intent.params.conversationId === 'string'
          ? intent.params.conversationId
          : state.conversationId
      const destinationBranchId =
        typeof intent.params.branchId === 'string' ? intent.params.branchId : state.branchId
      const attachment = await context.app.intelligence.promotion.promote({
        analysis,
        selectedFindingIds: findingIds,
        destinationConversationId,
        destinationBranchId,
      })
      return accepted(context.app, attachment, intent.operationId)
    }
    case 'cancel_analysis': {
      const analysisId = intent.params.analysisId
      if (typeof analysisId !== 'string')
        invalid('INVALID_PARAMS', 'cancel_analysis requires analysisId')
      const analysis = context.app
        .state()
        .analyses.find((candidate) => String(candidate.id) === analysisId)
      if (analysis === undefined)
        invalid('UNKNOWN_ANALYSIS', `Analysis ${analysisId} is not present`)
      const reason =
        typeof intent.params.reason === 'string'
          ? intent.params.reason
          : 'cancelled from analysis activity'
      if (!context.app.intelligence.analysis.cancel(analysis.id, reason)) {
        return unavailable(`Analysis ${analysisId} is not active in this process`)
      }
      context.setNotice(`Analysis cancellation requested: ${analysisId}`)
      return accepted(context.app, { analysisId, status: 'cancel_requested' }, intent.operationId)
    }
    case 'reconnect': {
      const runId = intent.params.runId
      if (
        typeof runId === 'string' &&
        context.app
          .state()
          .supervisors.some(
            (supervisor) =>
              supervisor.rootRunId !== undefined && String(supervisor.rootRunId) === runId,
          )
      ) {
        return dispatchSupervisorQuery('reconnect', context)
      }
      return undefined
    }
    case 'refresh_supervision':
      return dispatchSupervisorQuery('snapshot', context)
    case 'steer_worker':
    case 'cancel_worker':
      return dispatchSupervisorWorker(intent.command, context, intent.params, intent.operationId)
    case 'cancel_supervisor':
      return dispatchSupervisorCancel(context, intent.params, intent.operationId)
    case 'attach_worker':
      return unavailable(
        'Worker attachment is unavailable: the runtime snapshot does not carry the retained interactive reference required to reconnect the exact worker',
      )
    default:
      return undefined
  }
}
