import type {
  AnalysisCheck,
  AnalysisComparisonField,
  AnalysisComparisonSnapshot,
  AnalysisSourceRange,
} from '../domain/entities.js'
import type { JsonValue } from '../domain/entities-base.js'
import type { AnalysisComparisonResult } from './analysis-comparison-contracts.js'
import type { FrozenAnalysisEvidence } from './analysis-types.js'

function asJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return null
  }
}

function latencyMs(evidence: FrozenAnalysisEvidence): number | undefined {
  const run = evidence.run
  if (run === undefined) return undefined
  const started = Date.parse(run.startedAt)
  const ended = Date.parse(run.terminalAt ?? run.updatedAt)
  return Number.isFinite(started) && Number.isFinite(ended)
    ? Math.max(0, ended - started)
    : undefined
}

function toolCount(evidence: FrozenAnalysisEvidence): number {
  return evidence.events.filter((event) => event.event.kind === 'run.tool.call').length
}

export function capturedFields(
  baseline: FrozenAnalysisEvidence,
  candidate: FrozenAnalysisEvidence,
): readonly AnalysisComparisonField[] {
  const metadata = (evidence: FrozenAnalysisEvidence): Readonly<Record<string, unknown>> => {
    const run = evidence.run
    const receipt = run?.receipt
    return {
      'source.digest': evidence.source.digest,
      'source.complete': evidence.source.complete,
      'source.missing_history': evidence.source.missingHistory,
      'source.trace.digest': evidence.source.trace?.digest,
      'source.event_count': evidence.events.length,
      'source.message_count': evidence.messages.length,
      'source.message_part_count': evidence.messageParts.length,
      'run.id': run?.id,
      'run.turn_id': run?.turnId,
      'run.conversation_id': run?.conversationId,
      'run.branch_id': run?.branchId,
      'run.operation_id': run?.operationId,
      'run.status': run?.status,
      'run.complete': run?.complete,
      'run.event_count': run?.eventCount,
      'run.last_provider_sequence': run?.lastProviderSequence,
      'run.input_tokens': run?.inputTokens,
      'run.output_tokens': run?.outputTokens,
      'run.reasoning_tokens': run?.reasoningTokens,
      'run.cost_usd': run?.costUsd,
      'run.wall_time_ms': latencyMs(evidence),
      'run.model': run?.model,
      'run.profile_snapshot_id': run?.profileSnapshotId,
      'run.connection_id': run?.connectionId,
      'run.provider_session_id': run?.providerSessionId,
      'run.environment_id': run?.environmentId,
      'run.binding_id': run?.bindingId,
      'run.receipt_id': run?.receiptId,
      'run.terminal_reason': run?.terminalReason,
      'run.last_cursor': run?.lastCursor,
      'run.missing_sequence': run?.missingSequence,
      'run.interaction_count': run?.interactions.length,
      'run.activity_count': run?.activity.length,
      'run.event_detail_count': run?.eventDetails.length,
      'run.content_bytes': run?.contentBytes,
      'run.content_truncated': run?.contentTruncated,
      'run.activity_truncated': run?.activityTruncated,
      'run.event_details_truncated': run?.eventDetailsTruncated,
      'run.interactions_truncated': run?.interactionsTruncated,
      'receipt.profile_digest': receipt?.profileDigest,
      'receipt.connection_id': receipt?.requested.connectionId,
      'receipt.requested': receipt?.requested,
      'receipt.capabilities_digest': receipt?.capabilitiesDigest,
      'receipt.provider': receipt?.provider,
      'receipt.environment_id': receipt?.environmentId,
      'receipt.provider_session_id': receipt?.providerSessionId,
      tool_calls: toolCount(evidence),
    }
  }
  const left = metadata(baseline)
  const right = metadata(candidate)
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  return names.map((name) => {
    const leftValue = left[name]
    const rightValue = right[name]
    const baselinePresent = leftValue !== undefined
    const candidatePresent = rightValue !== undefined
    const baseline = baselinePresent ? asJson(leftValue) : undefined
    const candidate = candidatePresent ? asJson(rightValue) : undefined
    return {
      name,
      ...(baseline === undefined ? {} : { baseline }),
      ...(candidate === undefined ? {} : { candidate }),
      baselinePresent,
      candidatePresent,
      asymmetry:
        !baselinePresent && !candidatePresent
          ? 'both-missing'
          : !baselinePresent
            ? 'candidate-only'
            : !candidatePresent
              ? 'baseline-only'
              : 'none',
    }
  })
}

export function sourceRange(evidence: FrozenAnalysisEvidence): AnalysisSourceRange {
  const sequences = evidence.events.map((event) => event.sequence)
  const firstSequence = sequences.at(0)
  const lastSequence = sequences.at(-1)
  return {
    eventIds: evidence.events.map((event) => event.id),
    messageIds: evidence.messages.map((message) => message.id),
    messagePartIds: evidence.messageParts.map((part) => part.id),
    ...(firstSequence === undefined ? {} : { firstSequence }),
    ...(lastSequence === undefined ? {} : { lastSequence }),
  }
}

export function comparisonSnapshot(
  baseline: FrozenAnalysisEvidence,
  candidate: FrozenAnalysisEvidence,
  result: AnalysisComparisonResult,
): AnalysisComparisonSnapshot {
  return {
    baseline: baseline.source,
    candidate: candidate.source,
    fields: result.fields,
    rows: result.rows.map((row) => asJson(row) ?? null),
    paired: asJson(result.paired) ?? null,
    semantic: result.semantic,
  }
}

export function comparisonChecks(
  baseline: FrozenAnalysisEvidence,
  candidate: FrozenAnalysisEvidence,
): readonly AnalysisCheck[] {
  return [
    { id: 'baseline-frozen', status: 'passed', detail: String(baseline.source.digest) },
    { id: 'candidate-frozen', status: 'passed', detail: String(candidate.source.digest) },
    {
      id: 'captured-fields',
      status: 'passed',
      detail: 'Missing values and asymmetries are retained.',
    },
    { id: 'semantic-judge', status: 'unavailable', detail: 'No semantic judge was requested.' },
  ]
}
