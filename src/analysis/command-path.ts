import type { AnalysisCommand } from './commands.js'
import type { AnalysisRecord } from './model.js'
import { type AnalysisService, AnalysisServiceError } from './service.js'

export type AnalysisCommandResult = AnalysisRecord | { readonly branchId: string }

/** The controller shared by terminal and JSONL callers. */
export async function executeAnalysisCommand(input: {
  readonly service: AnalysisService
  readonly command: AnalysisCommand
  readonly operationId: string
  readonly sourceId: string
  readonly analysisId: string
}): Promise<AnalysisCommandResult> {
  const { service, command, operationId, sourceId, analysisId } = input
  if (command.command === 'analysis') {
    return service.run({
      operationId,
      analysisId,
      sourceId,
      kind: command.kind,
      ...(command.question ? { question: command.question } : {}),
    })
  }
  if (command.command === 'promote')
    return service.promote(command.analysisId, operationId, command.findingIds)
  if (command.command === 'fork')
    return service.forkFromAnalysis(command.analysisId, operationId, command.findingIds)
  throw new AnalysisServiceError(
    'INVALID_REQUEST',
    `/${command.command} needs paired source records and is not available from this run context`,
  )
}
