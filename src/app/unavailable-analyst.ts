import { AnalysisCapabilityError } from './analysis-types.js'
import type { AnalysisAnalyst, AnalysisExecutionEvent } from './analysis-execution-session.js'
import type { AnalysisRequest } from './analysis-types.js'
import type { EvalAnalystRequest } from '../adapters/analysis/eval-analyst.js'
import { AGENT_EVAL_VERSION } from '../adapters/analysis/agent-eval-version.js'

const ISSUE = {
  capability: 'trace-analysis',
  packageName: '@tangle-network/agent-eval',
  packageVersion: AGENT_EVAL_VERSION,
  reason: 'Trace analysis is not loaded until an analyst-backed analysis is requested.',
  reproduction:
    'Configure a production analysis connection before invoking /ask or another analysis command.',
} as const

export class UnavailableAnalyst implements AnalysisAnalyst {
  list(): readonly [] {
    return []
  }

  resolveAnalystIds(_request: AnalysisRequest): readonly string[] {
    throw new AnalysisCapabilityError(ISSUE)
  }

  async *stream(_request: EvalAnalystRequest): AsyncGenerator<AnalysisExecutionEvent, void, void> {
    yield await Promise.reject(new AnalysisCapabilityError(ISSUE))
  }
}
