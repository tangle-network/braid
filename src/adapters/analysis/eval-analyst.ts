import {
  type AnalystRegistry,
  type AnalystRunInputs,
  buildDefaultAnalystRegistry,
  type ExactAnalystRunEvent,
  type ExactAnalystRunResult,
  type ExactRegistryRunOpts,
} from '@tangle-network/agent-eval'
import type { AnalysisRecipe } from '../../app/analysis-types.js'
import { AnalysisCapabilityError, type AnalysisCapabilityIssue } from '../../app/analysis-types.js'
import { AGENT_EVAL_VERSION } from './agent-eval-version.js'
import type { AnalysisTraceBundle } from './trace-store.js'

export { AGENT_EVAL_VERSION }

export interface AnalystDescriptor {
  readonly id: string
  readonly description: string
  readonly version: string
  readonly cost: unknown
}

export interface AnalystRegistryPort {
  readonly list: () => ReadonlyArray<AnalystDescriptor>
  readonly runExactStream: AnalystRegistry['runExactStream']
}

export interface EvalAnalystRequest {
  readonly runId: string
  readonly sourceDigest: string
  readonly trace: AnalysisTraceBundle
  readonly question?: string
  readonly recipe?: AnalysisRecipe
  readonly analystIds?: readonly string[]
  readonly budgetUsd?: number
  readonly totalTimeoutMs?: number
  readonly signal?: AbortSignal
}

export interface EvalAnalystStreamEvent {
  readonly event: ExactAnalystRunEvent
  readonly result?: ExactAnalystRunResult
}

const RECIPE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  failure: ['failure-mode', 'failure'],
  cost: ['cost', 'efficiency-behavioral'],
  tools: ['tools', 'tool-use', 'efficiency-behavioral'],
  improvement: ['improvement'],
}

function unavailable(
  recipe: string,
  available: readonly AnalystDescriptor[],
): AnalysisCapabilityError {
  const issue: AnalysisCapabilityIssue = {
    capability: `analysis.recipe.${recipe}`,
    packageName: '@tangle-network/agent-eval',
    packageVersion: AGENT_EVAL_VERSION,
    reason: `No registered analyst implements the '${recipe}' recipe. Available analyst ids: ${available.map((entry) => entry.id).join(', ') || '(none)'}`,
    reproduction: `node --input-type=module -e "import { buildDefaultAnalystRegistry } from '@tangle-network/agent-eval'; console.log(buildDefaultAnalystRegistry().list())"`,
  }
  return new AnalysisCapabilityError(issue)
}

function assertBudget(value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError('Analysis budget must be a finite non-negative number')
  }
}

function assertTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError('Analysis timeout must be a positive finite number')
  }
}

export class AgentEvalAnalystAdapter {
  readonly #registry: AnalystRegistryPort
  readonly #unavailableIssue: AnalysisCapabilityIssue | undefined

  constructor(registry?: AnalystRegistryPort, unavailableIssue?: AnalysisCapabilityIssue) {
    this.#registry = registry ?? buildDefaultAnalystRegistry()
    this.#unavailableIssue = unavailableIssue
  }

  list(): ReadonlyArray<AnalystDescriptor> {
    if (this.#unavailableIssue !== undefined) return []
    return this.#registry.list()
  }

  resolveAnalystIds(request: Pick<EvalAnalystRequest, 'recipe' | 'analystIds'>): readonly string[] {
    if (this.#unavailableIssue !== undefined) {
      throw new AnalysisCapabilityError(this.#unavailableIssue)
    }
    const available = this.#registry.list()
    const availableIds = new Set(available.map((entry) => entry.id))
    if (request.analystIds !== undefined) {
      const unknown = request.analystIds.filter((id) => !availableIds.has(id))
      if (unknown.length > 0) throw unavailable(unknown[0] ?? 'custom', available)
      if (request.analystIds.length === 0) throw unavailable('custom', available)
      return [...request.analystIds]
    }

    const recipe = request.recipe ?? 'ask'
    if (recipe === 'ask') {
      if (available.length === 0) throw unavailable(recipe, available)
      return available.map((entry) => entry.id)
    }

    const candidates = RECIPE_ALIASES[recipe] ?? [recipe]
    const selected = candidates.find((candidate) => availableIds.has(candidate))
    if (selected === undefined) throw unavailable(recipe, available)
    return [selected]
  }

  async *stream(request: EvalAnalystRequest): AsyncGenerator<EvalAnalystStreamEvent, void, void> {
    assertBudget(request.budgetUsd)
    assertTimeout(request.totalTimeoutMs)
    const analystIds = this.resolveAnalystIds(request)
    const inputs: AnalystRunInputs = {
      traceStore: request.trace.store,
      custom: Object.fromEntries(
        analystIds.map((id) => [
          id,
          {
            question: request.question,
            recipe: request.recipe ?? 'ask',
            sourceDigest: request.sourceDigest,
          },
        ]),
      ),
    }
    const options: ExactRegistryRunOpts = {
      analystIds,
      budget:
        request.budgetUsd === undefined ? null : { kind: 'equal', totalUsd: request.budgetUsd },
      totalTimeoutMs: request.totalTimeoutMs ?? null,
      signal: request.signal ?? null,
      costLedger: null,
      costLedgerIdentity: null,
      costPhase: null,
      tags: Object.freeze({
        braid_source_digest: request.sourceDigest,
        braid_recipe: request.recipe ?? 'ask',
      }),
      priorFindings: null,
      chainFindings: false,
      missingInputMode: 'abort',
      applyRegistryHooks: false,
      useRegistryChat: false,
    }

    for await (const event of this.#registry.runExactStream(request.runId, inputs, options)) {
      if (event.type === 'run-completed') {
        yield { event, result: event.result }
      } else {
        yield { event }
      }
    }
  }
}

/** Keeps production analysis honest when its real prerequisites are unavailable. */
export function createUnavailableAgentEvalAnalystAdapter(
  issue: AnalysisCapabilityIssue,
): AgentEvalAnalystAdapter {
  const registry: AnalystRegistryPort = {
    list: () => [],
    runExactStream: async function* (
      _runId: string,
      _inputs: AnalystRunInputs,
      _options: ExactRegistryRunOpts,
    ) {
      // resolveAnalystIds throws before the registry can be reached.
    },
  }
  return new AgentEvalAnalystAdapter(registry, issue)
}
