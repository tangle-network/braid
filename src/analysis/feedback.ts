import {
  createFeedbackTrajectory,
  type FeedbackAttempt,
  type FeedbackLabel,
  type FeedbackTrajectory,
  parseFeedbackTrajectoriesJsonl,
  serializeFeedbackTrajectoriesJsonl,
} from '@tangle-network/agent-eval'

import type { AnalysisRecord } from './model.js'
import type { JsonValue } from './serialization.js'

export type FeedbackDecisionKind =
  | 'approve'
  | 'reject'
  | 'select'
  | 'edit'
  | 'rank'
  | 'rate'
  | 'comment'
  | 'metric_outcome'
  | 'policy_block'
  | 'revision_request'

export interface FeedbackDecision {
  readonly source: 'user' | 'judge' | 'environment' | 'metric' | 'policy' | 'system'
  readonly kind: FeedbackDecisionKind
  readonly value: JsonValue
  readonly reason?: string
  readonly findingId?: string
  readonly at: string
}

const SECRET_KEY =
  /(secret|password|passphrase|token|bearer|authorization|credential|private[_-]?key|api[-_]?key)/iu
const SECRET_MARKER = /^(containssecret|secretdesignated|issecret)$/iu
const VALUE_CONTAINER = /^(answer|answers|data|publicdata|response|value)$/iu
const SAFE_KEY_SUFFIX = /(ref|name|kind)$/iu

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function answerSpecContainsSecret(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = (value as { readonly fields?: unknown }).fields
  return (
    Array.isArray(fields) &&
    fields.some(
      (field) =>
        field !== null &&
        typeof field === 'object' &&
        !Array.isArray(field) &&
        (field as { readonly type?: unknown }).type === 'secret',
    )
  )
}

/** Fail closed before export; callers must pass already-safe structured data. */
export function assertFeedbackSafe(value: unknown): void {
  const seen = new Set<object>()
  const visit = (current: unknown, path: string, secretDesignated = false): void => {
    if (current === null || typeof current !== 'object') return
    if (seen.has(current)) throw new TypeError(`${path} contains a cycle`)
    seen.add(current)
    try {
      if (Array.isArray(current)) {
        current.forEach((child, index) => {
          visit(child, `${path}[${index}]`, secretDesignated)
        })
        return
      }
      if (!isPlainObject(current)) throw new TypeError(`${path} is not a JSON object`)
      const object = current as Record<string, unknown>
      if (answerSpecContainsSecret(object.answerSpec)) {
        throw new TypeError(`${path}.answerSpec designates a secret answer`)
      }
      const containsSecret =
        secretDesignated ||
        object.containsSecret === true ||
        object.secretDesignated === true ||
        object.isSecret === true
      for (const [key, child] of Object.entries(object)) {
        const keyIsSecret = SECRET_KEY.test(key) && !SAFE_KEY_SUFFIX.test(key)
        const isMarker = SECRET_MARKER.test(key)
        if (keyIsSecret && !isMarker) throw new TypeError(`${path}.${key} is secret-designated`)
        if (isMarker && child === true) throw new TypeError(`${path}.${key} marks secret data`)
        if (containsSecret && VALUE_CONTAINER.test(key))
          throw new TypeError(`${path}.${key} contains secret-designated data`)
        visit(child, `${path}.${key}`, containsSecret)
      }
    } finally {
      seen.delete(current)
    }
  }
  visit(value, '$', false)
}

function safeTrajectoryForAnalysis(
  record: AnalysisRecord,
  decisions: readonly FeedbackDecision[],
): FeedbackTrajectory {
  assertFeedbackSafe(decisions)
  const labels: FeedbackLabel[] = decisions.map((decision, index) => ({
    id: `feedback:${record.analysisId}:${index}`,
    source: decision.source,
    kind: decision.kind,
    value: decision.value,
    ...(decision.reason ? { reason: decision.reason } : {}),
    createdAt: decision.at,
    ...(decision.findingId ? { metadata: { findingId: decision.findingId } } : {}),
  }))
  const attempt: FeedbackAttempt = {
    id: `attempt:${record.analysisId}`,
    stepIndex: 0,
    artifactType: 'research',
    artifact: {
      analysisId: record.analysisId,
      sourceId: record.sourceId,
      sourceDigest: record.sourceDigest,
      status: record.status,
      findings: record.findings,
      citations: record.citations,
    },
    feedback: labels,
    createdAt: record.startedAt,
    metadata: { analystIds: record.analystIds },
  }
  const trajectory = createFeedbackTrajectory({
    id: `trajectory:${record.analysisId}`,
    projectId: 'braid',
    scenarioId: record.sourceId,
    task: {
      intent: record.question ?? `Analyze ${record.kind}`,
      context: { sourceDigest: record.sourceDigest },
    },
    attempts: [attempt],
    labels,
    outcome: {
      success: record.status === 'complete',
      ...(record.error ? { detail: record.error.message } : {}),
      observedAt: record.endedAt,
    },
    tags: { kind: record.kind, status: record.status },
    createdAt: record.startedAt,
    metadata: { sourceDigest: record.sourceDigest },
  })
  assertFeedbackSafe(trajectory)
  return trajectory
}

export function feedbackTrajectoryForAnalysis(
  record: AnalysisRecord,
  decisions: readonly FeedbackDecision[] = [],
): FeedbackTrajectory {
  return safeTrajectoryForAnalysis(record, decisions)
}

export function exportFeedbackTrajectories(trajectories: readonly FeedbackTrajectory[]): string {
  trajectories.forEach(assertFeedbackSafe)
  return serializeFeedbackTrajectoriesJsonl([...trajectories])
}

export function importFeedbackTrajectories(jsonl: string): FeedbackTrajectory[] {
  const trajectories = [...parseFeedbackTrajectoriesJsonl(jsonl)]
  trajectories.forEach(assertFeedbackSafe)
  return trajectories
}
