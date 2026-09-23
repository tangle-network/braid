import type { AnalysisRecord } from '../analysis/model.js'
import type { AnalysisService } from '../analysis/service.js'
import {
  evaluateApplicationAnalysis,
  type ApplicationEvaluationInput,
  type ApplicationEvaluationResult,
} from './evaluation-route.js'
import { AppError } from './errors.js'
import type { W11Judge } from '../evaluation/w11-runner.js'

/** Owns persisted-record checks before delegating semantic evaluation to agent-eval. */
export class ApplicationEvaluationService {
  readonly #analysis: AnalysisService | undefined

  constructor(analysis: AnalysisService | undefined) {
    this.#analysis = analysis
  }

  async evaluate(
    record: AnalysisRecord,
    judge: W11Judge,
    evaluationInputs: readonly ApplicationEvaluationInput[],
  ): Promise<ApplicationEvaluationResult> {
    if (!this.#analysis)
      throw new AppError(
        'ANALYSIS_UNAVAILABLE',
        'Evaluation is unavailable until encrypted analysis state is configured',
      )
    const persisted = await this.#analysis.get(record.analysisId)
    if (
      !persisted ||
      persisted.analysisId !== record.analysisId ||
      persisted.operationId !== record.operationId ||
      persisted.sourceDigest !== record.sourceDigest
    )
      throw new AppError(
        'ANALYSIS_NOT_FOUND',
        'Evaluation requires the exact persisted application analysis result',
      )
    return evaluateApplicationAnalysis({ record: persisted, judge, evaluationInputs })
  }
}
