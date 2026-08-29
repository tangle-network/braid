import {
  AgentExactRunControlRefSchema,
  InteractionBindingSchema,
  InteractionRequestSchema,
} from '@tangle-network/agent-interface'
import { isSensitiveFieldName } from './bounded-structured.js'
import type {
  AnalysisAttachmentRecord,
  AnalysisModelCallRecord,
  AnalysisRecord,
  RunRecord,
} from './entities.js'
import type { AutomationRuleRecord } from './entities-runtime.js'
import { isReplayCursor } from './ids.js'
import { localInteractionId } from './interaction-identity.js'
import {
  assertDate,
  assertDigest,
  assertEntityId,
  assertJsonValue,
  assertPublicReference,
  assertUniqueIds,
  fail,
  finiteNonNegative,
  finiteRatio,
  nonEmpty,
  objectValue,
} from './invariants-base.js'
import { assertRetainedRunAdmission } from './invariants-retained-admission.js'
import { assertAutomationRuleRecord } from './invariants-runtime.js'
import { safePublicIdentifier } from './provider-values.js'

export function assertRunRecord(record: RunRecord): void {
  assertEntityId('run', record.id, 'run.id')
  assertEntityId('conversation', record.conversationId, 'run.conversationId')
  assertEntityId('branch', record.branchId, 'run.branchId')
  assertEntityId('turn', record.turnId, 'run.turnId')
  assertEntityId('operation', record.operationId, 'run.operationId')
  finiteNonNegative(record.inputTokens, 'run.inputTokens')
  finiteNonNegative(record.outputTokens, 'run.outputTokens')
  if (record.tokensKnown !== undefined && record.tokensKnown !== false)
    fail('run.tokensKnown must be false when present')
  if (record.costUsd !== undefined) finiteNonNegative(record.costUsd, 'run.costUsd')
  if (record.usdKnown !== undefined && record.usdKnown !== false)
    fail('run.usdKnown must be false when present')
  if (record.estimatedCostUsd !== undefined)
    finiteNonNegative(record.estimatedCostUsd, 'run.estimatedCostUsd')
  if (record.llmCalls !== undefined) finiteNonNegative(record.llmCalls, 'run.llmCalls')
  if (record.llmLatencyMs !== undefined) finiteNonNegative(record.llmLatencyMs, 'run.llmLatencyMs')
  for (const [key, value] of Object.entries(record.promptCache ?? {})) {
    nonEmpty(key, 'run.promptCache key')
    finiteNonNegative(value, `run.promptCache.${key}`)
  }
  if (record.profileSnapshotId !== undefined)
    assertEntityId('profileSnapshot', record.profileSnapshotId, 'run.profileSnapshotId')
  if (record.connectionId !== undefined)
    assertEntityId('connection', record.connectionId, 'run.connectionId')
  if (record.providerSessionId !== undefined)
    assertEntityId('providerSession', record.providerSessionId, 'run.providerSessionId')
  if (record.harnessSessionId !== undefined) {
    nonEmpty(record.harnessSessionId, 'run.harnessSessionId')
    assertPublicReference(record.harnessSessionId, 'run.harnessSessionId')
  }
  if (record.environmentId !== undefined)
    assertEntityId('environment', record.environmentId, 'run.environmentId')
  if (record.controlRef !== undefined) {
    const parsed = AgentExactRunControlRefSchema.safeParse(record.controlRef)
    if (!parsed.success) fail('run.controlRef is invalid')
    if (
      record.providerSessionId !== undefined &&
      record.controlRef.sessionId !== record.providerSessionId
    ) {
      fail('run.controlRef.sessionId must match run.providerSessionId')
    }
  }
  assertRetainedRunAdmission(record)
  assertRunInteractions(record)
  if (record.bindingId !== undefined) assertEntityId('binding', record.bindingId, 'run.bindingId')
  if (record.receiptId !== undefined) assertEntityId('receipt', record.receiptId, 'run.receiptId')
  if (record.replayCursor !== undefined && !isReplayCursor(record.replayCursor))
    fail('run.replayCursor is invalid')
  assertDate(record.startedAt, 'run.startedAt')
  assertDate(record.updatedAt, 'run.updatedAt')
  if (record.terminalAt !== undefined) assertDate(record.terminalAt, 'run.terminalAt')
  const terminalStatuses = [
    'completed',
    'cancelled',
    'failed',
    'expired',
    'unknown',
    'aborted',
    'blocked',
  ]
  if (record.complete && !terminalStatuses.includes(record.status))
    fail('complete runs must have a terminal status')
}

function assertRunInteractions(record: RunRecord): void {
  if (!Array.isArray(record.interactions)) fail('run.interactions must be an array')
  const requestIds = record.interactions.map((interaction, index) =>
    assertBraidInteraction(interaction, record.id, index),
  )
  assertUniqueIds(requestIds, 'run.interactions.request')
  if (record.pendingInteractionIds === undefined) return
  const pendingIds = record.pendingInteractionIds.map((interactionId, index) => {
    assertEntityId('interaction', interactionId, `run.pendingInteractionIds[${index}]`)
    return interactionId
  })
  assertUniqueIds(pendingIds, 'run.pendingInteractionIds')
  const pending = new Set(pendingIds)
  for (const interaction of record.interactions) {
    const interactionId = interaction.request.id
    if (interaction.status === 'pending' && !pending.has(interactionId)) {
      fail(`run.pendingInteractionIds must include visible pending interaction ${interactionId}`)
    }
    if (interaction.status !== 'pending' && pending.has(interactionId)) {
      fail(`run.pendingInteractionIds cannot include non-pending interaction ${interactionId}`)
    }
  }
  if (!record.interactionsTruncated) {
    const visiblePending = record.interactions
      .filter((interaction) => interaction.status === 'pending')
      .map((interaction) => interaction.request.id)
    if (
      visiblePending.length !== pendingIds.length ||
      visiblePending.some((interactionId) => !pending.has(interactionId))
    ) {
      fail('run.pendingInteractionIds must match all interactions when history is complete')
    }
  }
}

function assertBraidInteraction(value: unknown, runId: string, index: number): string {
  const label = `run.interactions[${index}]`
  objectValue(value, label)

  const requestResult = InteractionRequestSchema.safeParse(value.request)
  if (!requestResult.success) fail(`${label}.request is invalid`)
  const request = requestResult.data

  const responseBindingResult = InteractionBindingSchema.safeParse(value.responseBinding)
  if (!responseBindingResult.success) fail(`${label}.responseBinding is invalid`)
  const responseBinding = responseBindingResult.data

  objectValue(value.source, `${label}.source`)
  if (value.source.eventId !== undefined)
    assertPublicIdentifier(value.source.eventId, `${label}.source.eventId`)
  if (
    value.source.sequence !== undefined &&
    (typeof value.source.sequence !== 'number' ||
      !Number.isSafeInteger(value.source.sequence) ||
      value.source.sequence <= 0)
  ) {
    fail(`${label}.source.sequence must be a positive safe integer`)
  }
  if (value.source.cursor !== undefined)
    assertPublicIdentifier(value.source.cursor, `${label}.source.cursor`)
  if (value.source.occurredAt !== undefined)
    assertDate(value.source.occurredAt, `${label}.source.occurredAt`)

  assertEntityId('run', value.runId, `${label}.runId`)
  if (value.runId !== runId) fail(`${label}.runId must match run.id`)
  if (request.binding.runId !== runId) fail(`${label}.request.binding.runId must match run.id`)
  if (responseBinding.runId !== runId) fail(`${label}.responseBinding.runId must match run.id`)
  if (request.binding.interactionId !== request.id)
    fail(`${label}.request.binding.interactionId must match request.id`)
  // Redaction recomputes the display request digest but preserves the response binding digest.
  assertPublicIdentifier(responseBinding.interactionId, `${label}.responseBinding.interactionId`)
  if (localInteractionId(runId, responseBinding.interactionId) !== request.id)
    fail(`${label}.responseBinding.interactionId does not map to request.id`)
  for (const key of ['provider', 'environmentId', 'sessionId', 'executionId'] as const) {
    if (responseBinding[key] !== request.binding[key])
      fail(`${label}.responseBinding.${key} must match request.binding.${key}`)
  }

  const statuses = ['pending', 'responding', 'declined', 'cancelled', 'resolved', 'unknown']
  if (typeof value.status !== 'string' || !statuses.includes(value.status))
    fail(`${label}.status is invalid`)

  if (value.responseOperation === undefined) {
    if (value.status === 'responding')
      fail(`${label}.responding interactions require responseOperation`)
    return request.id
  }

  objectValue(value.responseOperation, `${label}.responseOperation`)
  const responseOperation = value.responseOperation
  assertEntityId(
    'operation',
    responseOperation.operationId,
    `${label}.responseOperation.operationId`,
  )
  if (responseOperation.dataDigest !== undefined)
    assertDigest(responseOperation.dataDigest, `${label}.responseOperation.dataDigest`)
  if (typeof responseOperation.containsSecret !== 'boolean')
    fail(`${label}.responseOperation.containsSecret must be boolean`)
  if (
    responseOperation.requestedOutcome !== undefined &&
    responseOperation.requestedOutcome !== 'accepted' &&
    responseOperation.requestedOutcome !== 'declined' &&
    responseOperation.requestedOutcome !== 'cancelled'
  )
    fail(`${label}.responseOperation.requestedOutcome is invalid`)
  if (
    responseOperation.outcome !== 'accepted' &&
    responseOperation.outcome !== 'declined' &&
    responseOperation.outcome !== 'cancelled' &&
    responseOperation.outcome !== 'unknown'
  )
    fail(`${label}.responseOperation.outcome is invalid`)
  const expectedStatus =
    responseOperation.outcome === 'accepted'
      ? 'resolved'
      : responseOperation.outcome === 'declined'
        ? 'declined'
        : responseOperation.outcome === 'cancelled'
          ? 'cancelled'
          : 'unknown'
  if (value.status !== 'responding' && value.status !== expectedStatus) {
    fail(`${label}.responseOperation status does not match its outcome`)
  }
  if (value.status === 'responding' && responseOperation.outcome === 'unknown') {
    fail(`${label}.responding responseOperation cannot have unknown outcome`)
  }
  if (
    responseOperation.outcome !== 'unknown' &&
    request.allowedOutcomes !== undefined &&
    !request.allowedOutcomes.includes(responseOperation.outcome)
  )
    fail(`${label}.responseOperation.outcome is not allowed by request`)
  if (
    responseOperation.requestedOutcome !== undefined &&
    request.allowedOutcomes !== undefined &&
    !request.allowedOutcomes.includes(responseOperation.requestedOutcome)
  )
    fail(`${label}.responseOperation.requestedOutcome is not allowed by request`)
  if (
    responseOperation.outcome !== 'unknown' &&
    responseOperation.requestedOutcome !== undefined &&
    responseOperation.outcome !== responseOperation.requestedOutcome
  )
    fail(`${label}.responseOperation outcome does not match requestedOutcome`)
  if (responseOperation.containsSecret && responseOperation.dataDigest !== undefined)
    fail(`${label}.secret responseOperation cannot retain dataDigest`)
  if (
    !responseOperation.containsSecret &&
    request.answerSpec.fields.some(
      (field) => field.type === 'secret' || isSensitiveFieldName(field.name),
    )
  ) {
    fail(`${label}.responseOperation must mark secret request data`)
  }
  if (responseOperation.automationRule !== undefined) {
    assertAutomationRuleRecord(responseOperation.automationRule as AutomationRuleRecord)
  }
  return request.id
}

export function assertAnalysisRecord(record: AnalysisRecord): void {
  assertEntityId('analysis', record.id, 'analysis.id')
  if (record.analysisRunId !== undefined)
    assertEntityId('analysisRun', record.analysisRunId, 'analysis.analysisRunId')
  if (record.operationId !== undefined)
    assertEntityId('operation', record.operationId, 'analysis.operationId')
  if (record.requestDigest !== undefined)
    assertDigest(record.requestDigest, 'analysis.requestDigest')
  if (record.request !== undefined) assertJsonValue(record.request, 'analysis.request')
  assertEntityId('conversation', record.source.conversationId, 'analysis.source.conversationId')
  assertEntityId('branch', record.source.branchId, 'analysis.source.branchId')
  if (record.source.runId !== undefined)
    assertEntityId('run', record.source.runId, 'analysis.source.runId')
  if (record.source.throughMessageId !== undefined)
    assertEntityId('message', record.source.throughMessageId, 'analysis.source.throughMessageId')
  assertDigest(record.source.digest, 'analysis.source.digest')
  if (record.source.trace !== undefined) {
    assertEntityId('trace', record.source.trace.id, 'analysis.source.trace.id')
    assertDigest(record.source.trace.digest, 'analysis.source.trace.digest')
  }
  for (const finding of record.findings) {
    nonEmpty(finding.id, 'analysis.finding.id')
    nonEmpty(finding.text, 'analysis.finding.text')
    if (finding.confidence !== undefined)
      finiteRatio(finding.confidence, 'analysis.finding.confidence')
    for (const citation of finding.citations) assertAnalysisCitation(citation)
  }
  for (const analyst of record.analysts ?? []) {
    nonEmpty(analyst.analystId, 'analysis.analysts.analystId')
    if (!['pending', 'running', 'completed', 'skipped', 'failed'].includes(analyst.status))
      fail('analysis.analysts.status is invalid')
    if (analyst.startedAt !== undefined)
      assertDate(analyst.startedAt, 'analysis.analysts.startedAt')
    if (analyst.findingsCount !== undefined)
      finiteNonNegative(analyst.findingsCount, 'analysis.analysts.findingsCount')
    if (analyst.latencyMs !== undefined)
      finiteNonNegative(analyst.latencyMs, 'analysis.analysts.latencyMs')
  }
  if (record.sourceRange !== undefined) {
    for (const eventId of record.sourceRange.eventIds)
      assertEntityId('event', eventId, 'analysis.sourceRange.eventId')
    for (const messageId of record.sourceRange.messageIds)
      assertEntityId('message', messageId, 'analysis.sourceRange.messageId')
    for (const partId of record.sourceRange.messagePartIds)
      assertEntityId('messagePart', partId, 'analysis.sourceRange.messagePartId')
  }
  if (record.provenance !== undefined) {
    assertEntityId('operation', record.provenance.operationId, 'analysis.provenance.operationId')
    assertDigest(record.provenance.requestDigest, 'analysis.provenance.requestDigest')
    if (record.provenance.profileId !== undefined)
      assertEntityId('profile', record.provenance.profileId, 'analysis.provenance.profileId')
    if (record.provenance.profileDigest !== undefined)
      assertDigest(record.provenance.profileDigest, 'analysis.provenance.profileDigest')
    if (record.provenance.connectionDigest !== undefined)
      assertDigest(record.provenance.connectionDigest, 'analysis.provenance.connectionDigest')
    for (const check of record.provenance.checks) nonEmpty(check.id, 'analysis.check.id')
  }
  for (const check of record.checks ?? []) nonEmpty(check.id, 'analysis.check.id')
  for (const modelCall of record.modelCalls ?? []) assertAnalysisModelCall(modelCall)
  if (record.usage !== undefined) {
    finiteNonNegative(record.usage.input, 'analysis.usage.input')
    finiteNonNegative(record.usage.output, 'analysis.usage.output')
  }
  if (record.costUsd !== undefined) finiteNonNegative(record.costUsd, 'analysis.costUsd')
  if (record.wallTimeMs !== undefined) finiteNonNegative(record.wallTimeMs, 'analysis.wallTimeMs')
  assertDate(record.createdAt, 'analysis.createdAt')
  assertDate(record.updatedAt, 'analysis.updatedAt')
}

function assertAnalysisModelCall(record: AnalysisModelCallRecord): void {
  if (!Number.isSafeInteger(record.sequence) || record.sequence <= 0)
    fail('analysis.modelCalls.sequence must be a positive safe integer')
  assertPublicIdentifier(record.callId, 'analysis.modelCalls.callId')
  assertPublicIdentifier(record.callRef, 'analysis.modelCalls.callRef')
  if (!['/v1/chat/completions', '/v1/responses', 'unknown-path'].includes(record.path))
    fail('analysis.modelCalls.path is invalid')
  assertPublicIdentifier(record.model, 'analysis.modelCalls.model')
  if (record.provider !== undefined)
    assertPublicIdentifier(record.provider, 'analysis.modelCalls.provider')
  if (record.route !== undefined) assertPublicIdentifier(record.route, 'analysis.modelCalls.route')
  for (const [key, value] of Object.entries({
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedTokens: record.cachedTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    latencyMs: record.latencyMs,
    responseStatus: record.responseStatus,
  })) {
    if (value !== undefined) finiteNonNegative(value, `analysis.modelCalls.${key}`)
  }
  if (
    record.cost.status !== 'observed' &&
    record.cost.status !== 'estimated' &&
    record.cost.status !== 'unknown'
  ) {
    fail('analysis.modelCalls.cost.status is invalid')
  }
  if (record.cost.usd !== undefined)
    finiteNonNegative(record.cost.usd, 'analysis.modelCalls.cost.usd')
  if (record.cost.status === 'unknown' && record.cost.usd !== undefined)
    fail('analysis.modelCalls.cost.usd must be absent when cost is unknown')
  if (record.cost.status !== 'unknown' && record.cost.usd === undefined)
    fail('analysis.modelCalls.cost.usd is required when cost is known')
  if (typeof record.tokensKnown !== 'boolean')
    fail('analysis.modelCalls.tokensKnown must be boolean')
  if (record.tokensKnown && (record.inputTokens === undefined || record.outputTokens === undefined))
    fail('analysis.modelCalls known tokens require input and output')
  if (
    record.responseStatus !== undefined &&
    (!Number.isSafeInteger(record.responseStatus) ||
      record.responseStatus < 100 ||
      record.responseStatus > 599)
  )
    fail('analysis.modelCalls.responseStatus is invalid')
  if (record.failureCode !== undefined)
    assertPublicIdentifier(record.failureCode, 'analysis.modelCalls.failureCode')
  if (record.startedAt !== undefined) assertDate(record.startedAt, 'analysis.modelCalls.startedAt')
  if (record.endedAt !== undefined) assertDate(record.endedAt, 'analysis.modelCalls.endedAt')
  const unsafe = record as unknown as Record<string, unknown>
  if ('prompt' in unsafe || 'request' in unsafe || 'response' in unsafe || 'credential' in unsafe) {
    fail('analysis.modelCalls cannot retain model payloads or credentials')
  }
}

function assertPublicIdentifier(value: unknown, label: string): void {
  if (safePublicIdentifier(value) !== value) fail(`${label} must be a safe public identifier`)
}

export function assertAnalysisAttachment(record: AnalysisAttachmentRecord): void {
  assertEntityId('attachment', record.id, 'analysisAttachment.id')
  assertEntityId('operation', record.operationId, 'analysisAttachment.operationId')
  assertEntityId('analysis', record.analysisId, 'analysisAttachment.analysisId')
  if (record.analysisRunId !== undefined)
    assertEntityId('analysisRun', record.analysisRunId, 'analysisAttachment.analysisRunId')
  assertEntityId(
    'conversation',
    record.sourceConversationId,
    'analysisAttachment.sourceConversationId',
  )
  assertEntityId('branch', record.sourceBranchId, 'analysisAttachment.sourceBranchId')
  if (record.sourceRunId !== undefined)
    assertEntityId('run', record.sourceRunId, 'analysisAttachment.sourceRunId')
  assertDigest(record.sourceDigest, 'analysisAttachment.sourceDigest')
  assertEntityId(
    'conversation',
    record.destinationConversationId,
    'analysisAttachment.destinationConversationId',
  )
  assertEntityId('branch', record.destinationBranchId, 'analysisAttachment.destinationBranchId')
  assertEntityId(
    'analysis',
    record.provenance.analysisId,
    'analysisAttachment.provenance.analysisId',
  )
  assertDigest(record.provenance.sourceDigest, 'analysisAttachment.provenance.sourceDigest')
  if (record.provenance.analystProfileDigest !== undefined)
    assertDigest(
      record.provenance.analystProfileDigest,
      'analysisAttachment.provenance.analystProfileDigest',
    )
  for (const finding of record.selectedFindings) {
    nonEmpty(finding.id, 'analysisAttachment.finding.id')
    nonEmpty(finding.text, 'analysisAttachment.finding.text')
    for (const citation of finding.citations) assertAnalysisCitation(citation)
  }
  assertDate(record.createdAt, 'analysisAttachment.createdAt')
}

function assertAnalysisCitation(
  citation: AnalysisRecord['findings'][number]['citations'][number],
): void {
  assertEntityId('citation', citation.id, 'analysis.citation.id')
  if (citation.eventId !== undefined)
    assertEntityId('event', citation.eventId, 'analysis.citation.eventId')
  if (citation.messageId !== undefined)
    assertEntityId('message', citation.messageId, 'analysis.citation.messageId')
  if (citation.partId !== undefined)
    assertEntityId('messagePart', citation.partId, 'analysis.citation.partId')
  if (citation.start !== undefined) finiteNonNegative(citation.start, 'analysis.citation.start')
  if (citation.end !== undefined) finiteNonNegative(citation.end, 'analysis.citation.end')
  if (citation.start !== undefined && citation.end !== undefined && citation.end < citation.start) {
    fail('analysis.citation.end must not precede start')
  }
}
