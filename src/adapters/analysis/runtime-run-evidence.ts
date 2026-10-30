import {
  discoverDurableSupervisionRun,
  durableRunToolSpans,
  FileObserverJournal,
  projectPursuit,
} from '@tangle-network/agent-runtime/durable'
import { AnalysisSourceError, type RuntimeRunEvidence } from '../../app/analysis-types.js'
import type { RuntimeRunReference } from '../../domain/entities.js'
import { redactedSpan } from './trace-event-projection.js'

/**
 * Reads one Runtime durable run through Runtime's public readers. The run id must be one the
 * run directory's observer journal records; projection verifies the journal's digest chain.
 */
export async function readRuntimeRunEvidence(
  reference: RuntimeRunReference,
): Promise<RuntimeRunEvidence> {
  if (reference.remoteEndpointEnv !== undefined) {
    return (await import('./cloud-runtime-run-evidence.js')).readCloudRuntimeRunEvidence(reference)
  }
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
    lastSequence: Math.max(...attempts.map((attempt) => attempt.lastSequence)),
    settled: attempts.every((attempt) => attempt.status !== 'running'),
    // Runtime refuses a run directory with more than one root, so its spans are this run's.
    spans: (await durableRunToolSpans(runDir)).map(redactedSpan),
  }
}
