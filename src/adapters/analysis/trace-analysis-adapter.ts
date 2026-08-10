import {
  type AnalystRegistry,
  buildDefaultAnalystRegistry,
  type CustomTokenPricing,
  createDspyRlmTraceEngine,
  type TraceAnalysisEngine,
} from '@tangle-network/agent-eval'
import type { ExternalOptimizerModelExecutionObservation } from '@tangle-network/agent-eval/campaign'
import type { AgentProfile, HarnessType } from '@tangle-network/agent-interface'
import type { AnalysisCapabilityIssue } from '../../app/analysis-types.js'
import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionKind, ConnectionRecord } from '../../domain/entities.js'
import {
  bridgeRunnerSupportsModel,
  materializeBridgeModelRoute,
} from '../connections/cli-bridge-model-route.js'
import {
  normalizeCliBridgeProviderBaseUrl,
  normalizeTangleInferenceRuntimeBaseUrl,
} from '../connections/production-connection-endpoints.js'
import {
  connectionEndpoint,
  type ProductionConnectionOptions,
  readConnectionCredential,
} from '../connections/production-connections.js'
import { AGENT_EVAL_VERSION } from './agent-eval-version.js'
import {
  AgentEvalAnalystAdapter,
  createUnavailableAgentEvalAnalystAdapter,
} from './eval-analyst.js'
import { ModelExecutionScope } from './model-execution-scope.js'
import {
  type PythonCommandProbe,
  type PythonRunnerIdentity,
  type PythonRunnerSpec,
  resolvePythonRunner,
} from './python-runner.js'
import { registerBraidQuestionAnalyst } from './question-analyst.js'
import { createRuntimeTraceModelOwner } from './runtime-model-owner.js'

export type TraceAnalysisDiagnosticKind =
  | 'missing-python'
  | 'missing-python-package'
  | 'missing-model'
  | 'missing-credential'
  | 'unsupported-connection'
  | 'python-probe-failed'
  | 'connection-configuration-failed'
  | 'engine-configuration-failed'

export interface TraceAnalysisDiagnostic {
  readonly kind: TraceAnalysisDiagnosticKind
  readonly code: string
  readonly message: string
  readonly connectionId?: string
}

export interface TraceAnalysisAdapterOptions extends ProductionConnectionOptions {
  readonly connection: ConnectionRecord
  readonly profile: Readonly<AgentProfile>
  readonly model?: string
  readonly runner?: HarnessType
  readonly python?: PythonRunnerSpec
  readonly pythonCandidates?: readonly string[]
  readonly pythonProbe?: PythonCommandProbe
  readonly pythonProbeTimeoutMs?: number
  readonly pricing?: CustomTokenPricing
  readonly maxCostUsd?: number
  readonly maxOutputTokens?: number
  readonly maxReasoningTokens?: number
  readonly timeoutMs?: number
  readonly recordExecution?: (observation: ExternalOptimizerModelExecutionObservation) => void
}

export interface TraceAnalysisAdapterUnavailable {
  readonly status:
    | 'missing-python'
    | 'missing-python-package'
    | 'missing-model'
    | 'missing-credential'
    | 'unsupported-connection'
    | 'unavailable'
  readonly diagnostics: readonly [TraceAnalysisDiagnostic]
}

export interface TraceAnalysisAdapterReady {
  readonly status: 'engine-configured'
  readonly diagnostics: readonly []
  readonly engine: TraceAnalysisEngine
  readonly registry: AnalystRegistry
  readonly connection: Readonly<{
    readonly id: string
    readonly kind: ConnectionKind
    readonly endpoint: string
  }>
  readonly model: string
  readonly runner?: HarnessType
  readonly python: PythonRunnerIdentity
  readonly modelExecutions: () => readonly ExternalOptimizerModelExecutionObservation[]
  readonly modelExecutionScope: ModelExecutionScope
  /** The credential value itself is deliberately absent from this result. */
  readonly credentialState: 'provided' | 'not-required'
}

export type TraceAnalysisConfiguration = TraceAnalysisAdapterReady | TraceAnalysisAdapterUnavailable

function traceAnalysisIssue(reason: string): AnalysisCapabilityIssue {
  return {
    capability: 'trace-analysis',
    packageName: '@tangle-network/agent-eval',
    packageVersion: AGENT_EVAL_VERSION,
    reason,
    reproduction:
      'Check the selected AgentProfile model, connection credential, and Python agent-eval package before retrying /ask.',
  }
}

/** Converts the production configuration result into the analyst consumed by /ask. */
export function createTraceAnalysisAnalyst(
  configuration: TraceAnalysisConfiguration,
): AgentEvalAnalystAdapter {
  if (configuration.status === 'engine-configured') {
    return new AgentEvalAnalystAdapter(
      configuration.registry,
      undefined,
      configuration.modelExecutionScope,
    )
  }
  const diagnostic = configuration.diagnostics[0]
  return createUnavailableAgentEvalAnalystAdapter(
    traceAnalysisIssue(
      diagnostic?.message ?? 'The selected trace-analysis configuration is unavailable.',
    ),
  )
}

/** Used while first-run setup is open; it never substitutes a deterministic analyst. */
export function createUnavailableTraceAnalysisAnalyst(
  reason = 'Complete production setup before using trace analysis.',
): AgentEvalAnalystAdapter {
  return createUnavailableAgentEvalAnalystAdapter(traceAnalysisIssue(reason))
}

function unavailable(
  status: TraceAnalysisAdapterUnavailable['status'],
  diagnostic: TraceAnalysisDiagnostic,
): TraceAnalysisAdapterUnavailable {
  return { status, diagnostics: [diagnostic] }
}

function connectionId(record: ConnectionRecord): string {
  return String(record.id)
}

function connectionDiagnostic(
  error: unknown,
  record: ConnectionRecord,
): TraceAnalysisAdapterUnavailable {
  const id = connectionId(record)
  if (error instanceof ConnectionError) {
    if (error.code === 'CONNECTION_UNSUPPORTED') {
      return unavailable('unsupported-connection', {
        kind: 'unsupported-connection',
        code: error.code,
        message: error.message,
        connectionId: id,
      })
    }
    if (error.code.startsWith('CONNECTION_CREDENTIAL_')) {
      return unavailable('missing-credential', {
        kind: 'missing-credential',
        code: error.code,
        message: error.message,
        connectionId: id,
      })
    }
    return unavailable('unavailable', {
      kind: 'connection-configuration-failed',
      code: error.code,
      message: error.message,
      connectionId: id,
    })
  }
  return unavailable('unavailable', {
    kind: 'connection-configuration-failed',
    code: 'TRACE_ANALYSIS_CONNECTION_CONFIGURATION_FAILED',
    message: 'The selected connection could not be prepared for trace analysis.',
    connectionId: id,
  })
}

function modelFor(
  profile: Readonly<AgentProfile>,
  override: string | undefined,
): string | undefined {
  const model = (override ?? profile.model?.default)?.trim()
  return model === undefined || model.length === 0 ? undefined : model
}

function engineConfigurationMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : ''
  if (/pricing/u.test(detail)) {
    return 'The selected model has no recognized token pricing; provide pricing for this profile model.'
  }
  return 'The published agent-eval trace engine rejected the selected configuration.'
}

/**
 * Configure the model-backed trace analysts for one exact profile/connection pair.
 *
 * The returned registry is intentionally absent whenever the real engine cannot be
 * configured. Callers must surface the diagnostic instead of substituting a
 * deterministic-only registry.
 */
export async function createTraceAnalysisAdapter(
  options: TraceAnalysisAdapterOptions,
): Promise<TraceAnalysisConfiguration> {
  const { connection, profile } = options
  const id = connectionId(connection)

  if (connection.kind === 'tangle-sandbox') {
    return unavailable('unsupported-connection', {
      kind: 'unsupported-connection',
      code: 'TRACE_ANALYSIS_SANDBOX_UNSUPPORTED',
      message:
        'Tangle sandbox connections execute profiles as workspaces, but trace analysis requires a direct model endpoint. Select a cli-bridge or tangle-inference connection for /ask.',
      connectionId: id,
    })
  }

  const authoredModel = modelFor(profile, options.model)
  if (authoredModel === undefined) {
    return unavailable('missing-model', {
      kind: 'missing-model',
      code: 'TRACE_ANALYSIS_MODEL_REQUIRED',
      message: 'The selected AgentProfile has no non-empty model.default for trace analysis.',
      connectionId: id,
    })
  }
  const runner = options.runner ?? profile.harness
  if (connection.kind === 'cli-bridge' && runner === undefined) {
    return unavailable('unavailable', {
      kind: 'connection-configuration-failed',
      code: 'TRACE_ANALYSIS_RUNNER_REQUIRED',
      message: 'CLI Bridge trace analysis requires AgentProfile.harness.',
      connectionId: id,
    })
  }
  if (
    connection.kind === 'cli-bridge' &&
    runner !== undefined &&
    !bridgeRunnerSupportsModel(runner, authoredModel)
  ) {
    return unavailable('unavailable', {
      kind: 'connection-configuration-failed',
      code: 'CONNECTION_MODEL_HARNESS_MISMATCH',
      message: `Profile runner=${runner} does not support model=${authoredModel}; choose a matching runner or model before using /ask.`,
      connectionId: id,
    })
  }
  const model =
    connection.kind === 'cli-bridge' && runner !== undefined
      ? materializeBridgeModelRoute(runner, authoredModel, profile.model?.provider)
      : authoredModel

  let endpoint: string
  try {
    endpoint = connectionEndpoint(connection, options)
  } catch (error) {
    return connectionDiagnostic(error, connection)
  }

  const python = await resolvePythonRunner({
    ...(options.python === undefined ? {} : { runner: options.python }),
    ...(options.pythonCandidates === undefined ? {} : { candidates: options.pythonCandidates }),
    ...(options.pythonProbe === undefined ? {} : { probe: options.pythonProbe }),
    ...(options.pythonProbeTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.pythonProbeTimeoutMs }),
  })
  if (python.status !== 'ready') {
    const diagnostic: TraceAnalysisDiagnostic = {
      kind: python.status,
      code:
        python.status === 'missing-python'
          ? 'TRACE_ANALYSIS_PYTHON_REQUIRED'
          : python.status === 'missing-python-package'
            ? 'TRACE_ANALYSIS_PYTHON_PACKAGE_REQUIRED'
            : 'TRACE_ANALYSIS_PYTHON_PROBE_FAILED',
      message: python.message,
      connectionId: id,
    }
    return unavailable(
      python.status === 'missing-python' || python.status === 'missing-python-package'
        ? python.status
        : 'unavailable',
      diagnostic,
    )
  }

  let credential: string | undefined
  try {
    credential = await readConnectionCredential(connection, options, endpoint)
  } catch (error) {
    return connectionDiagnostic(error, connection)
  }

  const baseUrl =
    connection.kind === 'cli-bridge'
      ? normalizeCliBridgeProviderBaseUrl(endpoint, connection.id)
      : normalizeTangleInferenceRuntimeBaseUrl(endpoint, connection.id)
  try {
    const modelExecutionScope = new ModelExecutionScope()
    const owner = createRuntimeTraceModelOwner({
      profile,
      connection,
      baseUrl,
      ...(credential === undefined ? {} : { credential }),
      model,
      ...(options.pricing === undefined ? {} : { pricing: { ...options.pricing } }),
      ...(connection.kind !== 'tangle-inference' || options.routerComplete === undefined
        ? {}
        : { complete: options.routerComplete }),
      recordExecution: (observation) => {
        modelExecutionScope.record(observation)
        options.recordExecution?.(observation)
      },
    })
    const engine = createDspyRlmTraceEngine({
      call: owner.call,
      callRef: owner.callRef,
      recordExecution: owner.recordExecution,
      model,
      ...(owner.pricing === undefined ? {} : { pricing: { ...owner.pricing } }),
      ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.maxReasoningTokens === undefined
        ? {}
        : { maxReasoningTokens: options.maxReasoningTokens }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      runner: {
        command: python.runner.command,
        ...(python.runner.args === undefined ? {} : { args: [...python.runner.args] }),
      },
    })
    const registry = buildDefaultAnalystRegistry({ engine })
    registerBraidQuestionAnalyst(registry, engine)
    return {
      status: 'engine-configured',
      diagnostics: [],
      engine,
      registry,
      connection: { id, kind: connection.kind, endpoint },
      model,
      python: {
        command: python.runner.command,
        source: python.runner.source,
        ...(python.runner.args === undefined ? {} : { args: [...python.runner.args] }),
      },
      credentialState: credential === undefined ? 'not-required' : 'provided',
      ...(runner === undefined ? {} : { runner }),
      modelExecutions: owner.executions,
      modelExecutionScope,
    }
  } catch (error) {
    return unavailable('unavailable', {
      kind: 'engine-configuration-failed',
      code: 'TRACE_ANALYSIS_ENGINE_CONFIGURATION_FAILED',
      message: engineConfigurationMessage(error),
      connectionId: id,
    })
  }
}
