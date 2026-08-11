import { AgentExactRunControlRefSchema } from '@tangle-network/agent-interface'
import type {
  AnalysisAttachmentRecord,
  AnalysisModelCallRecord,
  AnalysisRecord,
  InteractionRecord,
  RunRecord,
} from './entities.js'
import { isReplayCursor } from './ids.js'
import {
  assertDate,
  assertDigest,
  assertEntityId,
  assertJsonValue,
  fail,
  failUnsupported,
  finiteNonNegative,
  finiteRatio,
  nonEmpty,
  objectValue,
} from './invariants-base.js'
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
  if (record.environmentId !== undefined)
    assertEntityId('environment', record.environmentId, 'run.environmentId')
  if (record.controlRef !== undefined) {
    const parsed = AgentExactRunControlRefSchema.safeParse(record.controlRef)
    if (!parsed.success) fail('run.controlRef is invalid')
    if (record.controlRef.runId !== record.id) fail('run.controlRef.runId must match run.id')
    if (
      record.providerSessionId !== undefined &&
      record.controlRef.sessionId !== record.providerSessionId
    ) {
      fail('run.controlRef.sessionId must match run.providerSessionId')
    }
  }
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

export function assertInteractionRecord(record: InteractionRecord): void {
  assertEntityId('interaction', record.id, 'interaction.id')
  assertEntityId('run', record.runId, 'interaction.runId')
  if (record.providerSessionId !== undefined)
    assertEntityId('providerSession', record.providerSessionId, 'interaction.providerSessionId')
  if (record.request.id !== record.id) fail('interaction.request.id must match interaction.id')
  nonEmpty(record.request.kind, 'interaction.request.kind')
  nonEmpty(record.request.title, 'interaction.request.title')
  if (!Array.isArray(record.request.answerSpec.fields))
    fail('interaction.answerSpec.fields must be an array')
  const fieldNames = new Set<string>()
  for (const field of record.request.answerSpec.fields) {
    objectValue(field, 'interaction.answerSpec.field')
    nonEmpty(field.name, 'interaction.answerSpec.field.name')
    nonEmpty(field.label, 'interaction.answerSpec.field.label')
    if (fieldNames.has(field.name))
      fail(`interaction.answerSpec contains duplicate field ${field.name}`)
    fieldNames.add(field.name)
    if (field.type === 'secret' && 'default' in field)
      fail('secret interaction fields cannot have defaults')
  }
  if (record.request.subject !== undefined) {
    switch (record.request.subject.type) {
      case 'tool':
        nonEmpty(record.request.subject.toolName, 'interaction.subject.toolName')
        break
      case 'command':
        nonEmpty(record.request.subject.command, 'interaction.subject.command')
        break
      case 'file':
        nonEmpty(record.request.subject.path, 'interaction.subject.path')
        break
      case 'resource':
        nonEmpty(record.request.subject.uri, 'interaction.subject.uri')
        break
      default:
        failUnsupported(record.request.subject, 'interaction subject type')
    }
  }
  if (record.request.timeoutMs !== undefined)
    finiteNonNegative(record.request.timeoutMs, 'interaction.request.timeoutMs')
  if (record.resolution !== undefined) {
    assertEntityId('operation', record.resolution.operationId, 'interaction.resolution.operationId')
    if (record.resolution.containsSecret && record.resolution.publicData !== undefined) {
      fail('secret interaction resolution cannot contain publicData')
    }
    if (record.resolution.dataDigest !== undefined)
      assertDigest(record.resolution.dataDigest, 'interaction.resolution.dataDigest')
  }
  assertNoSecretInteractionData(record)
  assertDate(record.createdAt, 'interaction.createdAt')
  assertDate(record.updatedAt, 'interaction.updatedAt')
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

function assertPublicIdentifier(value: string, label: string): void {
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

export function assertNoSecretInteractionData(record: InteractionRecord): void {
  const hasSecretField = record.request.answerSpec.fields.some((field) => field.type === 'secret')
  const publicData = record.resolution?.publicData
  if (publicData !== undefined) {
    objectValue(publicData, 'interaction.resolution.publicData')
    for (const [key, value] of Object.entries(publicData)) {
      if (
        /(secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key)/iu.test(
          key,
        )
      ) {
        fail(`interaction.resolution.publicData.${key} is secret-designated and cannot be retained`)
      }
      if (
        typeof value !== 'string' &&
        typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value)) &&
        !(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
      ) {
        fail(`interaction.resolution.publicData.${key} contains an unsupported value`)
      }
    }
  }
  if (hasSecretField && publicData !== undefined) {
    fail('secret interaction data cannot be retained in the domain state')
  }
  if (record.resolution?.containsSecret && publicData !== undefined) {
    fail('secret interaction data cannot be retained in the domain state')
  }
}
