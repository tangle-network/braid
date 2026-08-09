import type { BraidEvent } from '../domain/events.js'
import type { AnalysisApplicationHost } from './analysis-types.js'
import { AnalysisPersistenceError } from './analysis-types.js'

export async function commitAnalysisEvent(
  host: AnalysisApplicationHost,
  event: BraidEvent,
): Promise<void> {
  try {
    if (host.commitAndWait !== undefined) {
      await host.commitAndWait(event)
      return
    }
    await host.commit(event)
  } catch (error) {
    if (error instanceof AnalysisPersistenceError) throw error
    throw new AnalysisPersistenceError(
      `Durable analysis event '${event.kind}' could not be committed; the operation is left for restart reconciliation.`,
      error,
    )
  }
}
