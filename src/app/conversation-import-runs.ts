import { type AgentProfile, snapshotAgentProfile } from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type {
  AnalysisCitation,
  AnalysisFinding,
  AnalysisRecord,
  FeedbackDecisionRecord,
  RunRecord,
} from '../domain/entities.js'
import type { ConversationId, OperationId } from '../domain/ids.js'
import { parseDigestValue } from '../domain/ids.js'
import { createAdmissionReceipt } from '../domain/receipts.js'
import { UNKNOWN_RUN_CAPABILITIES } from '../ports/execution.js'
import type { ConversationImportIds } from './conversation-import-values.js'
import {
  booleanValue,
  canonicalDateTime,
  exactString,
  finiteInteger,
  finiteNumber,
  importRecord,
  oneOf,
  optionalFiniteNumber,
  optionalString,
  requiredString,
  stringValue,
} from './conversation-import-values.js'
import { AppError } from './errors.js'

const RUN_STATUSES = [
  'prepared',
  'starting',
  'running',
  'waiting',
  'detached',
  'reconnecting',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
  'expired',
  'unknown',
  'streaming',
  'aborted',
  'blocked',
] as const
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'cancelled',
  'failed',
  'expired',
  'unknown',
  'aborted',
  'blocked',
])
const ANALYSIS_STATUSES = [
  'preparing',
  'running',
  'completed',
  'cancelled',
  'failed',
  'unknown',
] as const
const TERMINAL_ANALYSIS_STATUSES = new Set(['completed', 'cancelled', 'failed', 'unknown'])
const FEEDBACK_CATEGORIES = [
  'approval',
  'rejection',
  'revision',
  'retry',
  'fork',
  'selection',
  'automation',
] as const

export interface ImportedConversationRuns {
  readonly runs: readonly RunRecord[]
  readonly analyses: readonly AnalysisRecord[]
  readonly feedbackDecisions: readonly FeedbackDecisionRecord[]
}

export function importConversationRuns(input: {
  readonly ids: ConversationImportIds
  readonly sourceConversationId: string
  readonly conversationId: ConversationId
  readonly operationId: OperationId
  readonly fallbackProfile: Readonly<AgentProfile>
  readonly runs: readonly Record<string, unknown>[]
  readonly analyses: readonly Record<string, unknown>[]
  readonly feedbackDecisions: readonly Record<string, unknown>[]
}): ImportedConversationRuns {
  const runs = input.runs.map((record, index) => importRun(input, record, `runs[${index}]`))
  const analyses = input.analyses.map((record, index) =>
    importAnalysis(input, record, `analyses[${index}]`),
  )
  const feedbackDecisions = input.feedbackDecisions.map((record, index) => {
    const label = `feedbackDecisions[${index}]`
    exactString(record.conversationId, input.sourceConversationId, `${label}.conversationId`)
    return {
      id: input.ids.id('feedbackDecision', record.id, `${label}.id`),
      conversationId: input.conversationId,
      category: oneOf(record.category, FEEDBACK_CATEGORIES, `${label}.category`),
      chosenOption: requiredString(record.chosenOption, `${label}.chosenOption`),
      ...optionalField('feedback', optionalString(record.feedback, `${label}.feedback`)),
      automated: booleanValue(record.automated, `${label}.automated`),
      createdAt: requiredString(record.createdAt, `${label}.createdAt`),
    } satisfies FeedbackDecisionRecord
  })
  return { runs, analyses, feedbackDecisions }
}

function importRun(
  input: Parameters<typeof importConversationRuns>[0],
  record: Readonly<Record<string, unknown>>,
  label: string,
): RunRecord {
  const id = input.ids.id('run', record.id, `${label}.id`)
  exactString(record.conversationId, input.sourceConversationId, `${label}.conversationId`)
  const turnId = input.ids.id('turn', record.turnId, `${label}.turnId`)
  const branchId = input.ids.id('branch', record.branchId, `${label}.branchId`)
  const sourceStatus = oneOf(record.status, RUN_STATUSES, `${label}.status`)
  const status = TERMINAL_RUN_STATUSES.has(sourceStatus) ? sourceStatus : 'unknown'
  const receipt = importReceipt(record.receipt, {
    runId: id,
    turnId,
    operationId: input.operationId,
    conversationId: input.conversationId,
    branchId,
    fallbackProfile: input.fallbackProfile,
    label: `${label}.receipt`,
  })
  const complete = booleanValue(record.complete, `${label}.complete`)
  const terminalAt = optionalString(record.terminalAt, `${label}.terminalAt`)
  const missingSequence = optionalSequence(record.missingSequence, `${label}.missingSequence`)
  return {
    id,
    conversationId: input.conversationId,
    branchId,
    turnId,
    operationId: input.operationId,
    status,
    inputTokens: finiteNumber(record.inputTokens, `${label}.inputTokens`),
    outputTokens: finiteNumber(record.outputTokens, `${label}.outputTokens`),
    ...optionalField(
      'reasoningTokens',
      optionalFiniteNumber(record.reasoningTokens, `${label}.reasoningTokens`),
    ),
    ...optionalField('costUsd', optionalFiniteNumber(record.costUsd, `${label}.costUsd`)),
    ...optionalField('model', optionalString(record.model, `${label}.model`)),
    ...optionalField('error', optionalString(record.error, `${label}.error`)),
    receipt,
    capabilities: UNKNOWN_RUN_CAPABILITIES,
    ...optionalField(
      'terminalReason',
      optionalString(record.terminalReason, `${label}.terminalReason`),
    ),
    lastProviderSequence: 0,
    eventCount: finiteInteger(record.eventCount, `${label}.eventCount`),
    ...optionalField(
      'contentBytes',
      optionalFiniteNumber(record.contentBytes, `${label}.contentBytes`),
    ),
    ...(record.contentTruncated === undefined
      ? {}
      : { contentTruncated: booleanValue(record.contentTruncated, `${label}.contentTruncated`) }),
    ...optionalField('missingSequence', missingSequence),
    interactions: [],
    activity: [],
    eventDetails: [],
    ...(arrayHasItems(record.interactions) || record.interactionsTruncated === true
      ? { interactionsTruncated: true }
      : {}),
    ...(arrayHasItems(record.activity) || record.activityTruncated === true
      ? { activityTruncated: true }
      : {}),
    ...(arrayHasItems(record.eventDetails) || record.eventDetailsTruncated === true
      ? { eventDetailsTruncated: true }
      : {}),
    complete: complete && TERMINAL_RUN_STATUSES.has(status),
    startedAt: requiredString(record.startedAt, `${label}.startedAt`),
    updatedAt: requiredString(record.updatedAt, `${label}.updatedAt`),
    ...optionalField('terminalAt', terminalAt),
  }
}

function importReceipt(
  value: unknown,
  input: {
    readonly runId: string
    readonly turnId: string
    readonly operationId: string
    readonly conversationId: string
    readonly branchId: string
    readonly fallbackProfile: Readonly<AgentProfile>
    readonly label: string
  },
) {
  const receipt = importRecord(value, input.label)
  const requested = importRecord(receipt.requested, `${input.label}.requested`)
  let profile: Readonly<AgentProfile>
  try {
    profile =
      requested.profile === undefined
        ? input.fallbackProfile
        : snapshotAgentProfile(requested.profile)
  } catch {
    throw new AppError('IMPORT_INVALID', `${input.label}.requested.profile is invalid`)
  }
  return createAdmissionReceipt({
    runId: input.runId,
    turnId: input.turnId,
    operationId: input.operationId,
    conversationId: input.conversationId,
    branchId: input.branchId,
    admittedAt: canonicalDateTime(receipt.admittedAt, `${input.label}.admittedAt`),
    profile,
    text: stringValue(requested.text, `${input.label}.requested.text`),
    capabilities: UNKNOWN_RUN_CAPABILITIES,
    warnings: ['IMPORTED_OFFLINE'],
    admissionStatus: 'unavailable',
  })
}

function importAnalysis(
  input: Parameters<typeof importConversationRuns>[0],
  record: Readonly<Record<string, unknown>>,
  label: string,
): AnalysisRecord {
  const source = importRecord(record.source, `${label}.source`)
  exactString(source.conversationId, input.sourceConversationId, `${label}.source.conversationId`)
  const branchId = input.ids.id('branch', source.branchId, `${label}.source.branchId`)
  const runId =
    source.runId === undefined
      ? undefined
      : input.ids.id('run', source.runId, `${label}.source.runId`)
  const throughMessageId =
    source.throughMessageId === undefined
      ? undefined
      : input.ids.id('message', source.throughMessageId, `${label}.source.throughMessageId`)
  const complete = booleanValue(source.complete, `${label}.source.complete`)
  let importedSourceDigest: ReturnType<typeof parseDigestValue>
  try {
    importedSourceDigest = parseDigestValue(source.digest)
  } catch {
    throw new AppError('IMPORT_INVALID', `${label}.source.digest is invalid`)
  }
  const sourceDigest = canonicalDigest({
    importedFrom: importedSourceDigest,
    conversationId: input.conversationId,
    branchId,
    runId: runId ?? null,
    throughMessageId: throughMessageId ?? null,
    complete,
  })
  const sourceStatus = oneOf(record.status, ANALYSIS_STATUSES, `${label}.status`)
  const findingsValue = record.findings
  if (!Array.isArray(findingsValue)) {
    throw new AppError('IMPORT_INVALID', `${label}.findings must be an array`)
  }
  const findings = findingsValue.map((value, index) =>
    importFinding(input.ids, value, `${label}.findings[${index}]`),
  )
  return {
    id: input.ids.id('analysis', record.id, `${label}.id`),
    source: {
      conversationId: input.conversationId,
      branchId,
      ...optionalField('runId', runId),
      ...optionalField('throughMessageId', throughMessageId),
      digest: sourceDigest,
      complete,
      ...optionalField(
        'missingHistory',
        optionalMissingHistory(input.ids, source.missingHistory, `${label}.source.missingHistory`),
      ),
    },
    ...optionalField('question', optionalString(record.question, `${label}.question`)),
    ...optionalField('recipe', optionalString(record.recipe, `${label}.recipe`)),
    status: TERMINAL_ANALYSIS_STATUSES.has(sourceStatus) ? sourceStatus : 'unknown',
    findings,
    ...optionalField('usage', optionalUsage(record.usage, `${label}.usage`)),
    ...optionalField('costUsd', optionalFiniteNumber(record.costUsd, `${label}.costUsd`)),
    ...optionalField('wallTimeMs', optionalFiniteNumber(record.wallTimeMs, `${label}.wallTimeMs`)),
    createdAt: requiredString(record.createdAt, `${label}.createdAt`),
    updatedAt: requiredString(record.updatedAt, `${label}.updatedAt`),
  }
}

function importFinding(ids: ConversationImportIds, value: unknown, label: string): AnalysisFinding {
  const finding = importRecord(value, label)
  if (!Array.isArray(finding.citations)) {
    throw new AppError('IMPORT_INVALID', `${label}.citations must be an array`)
  }
  const confidence = optionalFiniteNumber(finding.confidence, `${label}.confidence`)
  if (confidence !== undefined && confidence > 1) {
    throw new AppError('IMPORT_INVALID', `${label}.confidence must not exceed one`)
  }
  const citations = finding.citations.map((citation, index) =>
    importCitation(ids, citation, `${label}.citations[${index}]`),
  )
  // Imports preserve event identifiers as historical provenance, but source journal
  // events are intentionally not replayed as live Braid events. Only references to
  // imported message data remain resolvable after the external controls are removed.
  const hasRetainedSupport = citations.some(
    (citation) => citation.messageId !== undefined || citation.partId !== undefined,
  )
  return {
    id: requiredString(finding.id, `${label}.id`),
    text: requiredString(finding.text, `${label}.text`),
    ...(finding.severity === undefined
      ? {}
      : {
          severity: oneOf(
            finding.severity,
            ['info', 'low', 'medium', 'high', 'critical'] as const,
            `${label}.severity`,
          ),
        }),
    ...optionalField('confidence', confidence),
    citations,
    supported: booleanValue(finding.supported, `${label}.supported`) && hasRetainedSupport,
  }
}

function importCitation(
  ids: ConversationImportIds,
  value: unknown,
  label: string,
): AnalysisCitation {
  const citation = importRecord(value, label)
  return {
    id: ids.id('citation', citation.id, `${label}.id`),
    ...(citation.eventId === undefined
      ? {}
      : { eventId: ids.id('event', citation.eventId, `${label}.eventId`) }),
    ...(citation.messageId === undefined
      ? {}
      : { messageId: ids.id('message', citation.messageId, `${label}.messageId`) }),
    ...(citation.partId === undefined
      ? {}
      : { partId: ids.id('messagePart', citation.partId, `${label}.partId`) }),
    ...optionalField('start', optionalFiniteNumber(citation.start, `${label}.start`)),
    ...optionalField('end', optionalFiniteNumber(citation.end, `${label}.end`)),
    ...(citation.quote === undefined
      ? {}
      : { quote: stringValue(citation.quote, `${label}.quote`) }),
  }
}

function optionalUsage(value: unknown, label: string) {
  if (value === undefined) return undefined
  const usage = importRecord(value, label)
  return {
    input: finiteNumber(usage.input, `${label}.input`),
    output: finiteNumber(usage.output, `${label}.output`),
    ...optionalField('reasoning', optionalFiniteNumber(usage.reasoning, `${label}.reasoning`)),
    ...optionalField('costUsd', optionalFiniteNumber(usage.costUsd, `${label}.costUsd`)),
    ...optionalField('model', optionalString(usage.model, `${label}.model`)),
  }
}

function optionalSequence(value: unknown, label: string) {
  if (value === undefined) return undefined
  const sequence = importRecord(value, label)
  const from = finiteInteger(sequence.from, `${label}.from`)
  const to = finiteInteger(sequence.to, `${label}.to`)
  if (to < from) throw new AppError('IMPORT_INVALID', `${label}.to must not precede from`)
  return { from, to }
}

function optionalMissingHistory(ids: ConversationImportIds, value: unknown, label: string) {
  if (value === undefined) return undefined
  const range = importRecord(value, label)
  const fromSequence = finiteInteger(range.fromSequence, `${label}.fromSequence`)
  const toSequence =
    range.toSequence === undefined
      ? undefined
      : finiteInteger(range.toSequence, `${label}.toSequence`)
  if (toSequence !== undefined && toSequence < fromSequence) {
    throw new AppError('IMPORT_INVALID', `${label}.toSequence must not precede fromSequence`)
  }
  return {
    runId: ids.id('run', range.runId, `${label}.runId`),
    fromSequence,
    ...optionalField('toSequence', toSequence),
    reason: oneOf(
      range.reason,
      ['gap', 'expired-cursor', 'provider-missing', 'replay-unsupported'] as const,
      `${label}.reason`,
    ),
  }
}

function arrayHasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function optionalField<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: T })
}
