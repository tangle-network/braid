import type { ToolSpan } from '@tangle-network/agent-eval/traces'
import {
  discoverDurableSupervisionRun,
  durableRunToolSpans,
  FileObserverJournal,
  projectPursuit,
} from '@tangle-network/agent-runtime/durable'
import { AnalysisSourceError, type RuntimeRunEvidence } from '../../app/analysis-types.js'
import type { RuntimeRunReference } from '../../domain/entities.js'
import { safeAnalysisText, safeAnalysisValue } from './trace-event-projection.js'

/**
 * Reads one Runtime durable run through Runtime's public readers. The run id must be one the
 * run directory's observer journal records; projection verifies the journal's digest chain.
 */
export async function readRuntimeRunEvidence(
  reference: RuntimeRunReference,
): Promise<RuntimeRunEvidence> {
  const { runId, runDir } = reference
  const discovery = await discoverDurableSupervisionRun(runDir)
  const journal =
    discovery.observer === undefined
      ? undefined
      : await FileObserverJournal.open(discovery.observer.path)
  if (journal === undefined) {
    throw new AnalysisSourceError(`${runDir} holds no Runtime observer journal`)
  }
  const projection = projectPursuit(await journal.read())
  const attempts = projection.runs.filter((run) => run.runId === runId)
  if (attempts.length === 0) {
    throw new AnalysisSourceError(`Runtime run ${runId} is not recorded in ${runDir}`)
  }
  return {
    runId,
    runDir,
    pursuitId: projection.pursuitId,
    chainTip: projection.chainTip,
    sequence: projection.sequence,
    settled: attempts.every((attempt) => attempt.status !== 'running'),
    spans: (await durableRunToolSpans(runDir)).map(redactedSpan),
  }
}

function redactedSpan(span: ToolSpan): ToolSpan {
  return {
    ...span,
    args: safeAnalysisValue(span.args),
    ...(span.result === undefined ? {} : { result: safeAnalysisValue(span.result) }),
    ...(span.error === undefined ? {} : { error: safeAnalysisText(span.error) }),
    ...(span.attributes === undefined
      ? {}
      : { attributes: safeAnalysisValue(span.attributes) as ToolSpan['attributes'] }),
  }
}
