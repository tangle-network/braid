import type { AnalysisCommand } from '../analysis/commands.js'
import type { AnalysisCommandResult } from '../analysis/command-path.js'
import { executeAnalysisCommand as executeCommand } from '../analysis/command-path.js'
import type { AnalysisService } from '../analysis/service.js'
import { AppError } from './errors.js'
import { analysisIdForOperation } from './operation-authority.js'

/** Owns the application entry point into the persisted analysis service. */
export class ApplicationAnalysisService {
  readonly #service: AnalysisService | undefined
  readonly #sourceId: () => string

  constructor(options: { readonly service: AnalysisService | undefined; readonly sourceId: () => string }) {
    this.#service = options.service
    this.#sourceId = options.sourceId
  }

  async execute(command: AnalysisCommand, operationId: string): Promise<AnalysisCommandResult> {
    if (!this.#service)
      throw new AppError(
        'ANALYSIS_UNAVAILABLE',
        'Analysis is unavailable until encrypted analysis state is configured',
      )
    if (!operationId) throw new AppError('OPERATION_ID_REQUIRED', 'Analysis requires operationId')
    return executeCommand({
      service: this.#service,
      command,
      operationId,
      sourceId: this.#sourceId(),
      analysisId:
        command.command === 'analysis'
          ? analysisIdForOperation(operationId)
          : command.command === 'promote' || command.command === 'fork'
            ? command.analysisId
            : analysisIdForOperation(operationId),
    })
  }

  service(): AnalysisService | undefined {
    return this.#service
  }
}
