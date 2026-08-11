import {
  INPUT_VALUE,
  LLM_CACHED_TOKENS,
  LLM_COST_USD,
  LLM_INPUT_TOKENS,
  LLM_MODEL_NAME,
  LLM_OUTPUT_TOKENS,
  LLM_REASONING_TOKENS,
  OPENINFERENCE_SPAN_KIND,
  OUTPUT_VALUE,
} from '@tangle-network/agent-eval'
import { profileModelSettings } from '../../app/profile-model-settings.js'
import type { FrozenAnalysisEvent } from '../../app/analysis-types.js'
import type { TurnUsage } from '../../domain/entities.js'
import type { BraidEvent } from '../../domain/events.js'
import { redactSensitiveText, redactStructuredValue } from '../../domain/redaction.js'

const MAX_TRACE_TEXT_BYTES = 16 * 1024
const MAX_TRACE_VALUE_BYTES = 16 * 1024

export function safeAnalysisText(value: unknown): string {
  if (typeof value === 'string') return redactSensitiveText(value, MAX_TRACE_TEXT_BYTES)
  try {
    return redactSensitiveText(
      JSON.stringify(safeAnalysisValue(value)) ?? String(value),
      MAX_TRACE_TEXT_BYTES,
    )
  } catch {
    return '[redacted value]'
  }
}

export function safeAnalysisValue(value: unknown): unknown {
  try {
    return redactStructuredValue(value, undefined, {
      maxDepth: 8,
      maxItems: 256,
      maxBytes: MAX_TRACE_VALUE_BYTES,
    })
  } catch {
    return '[redacted value]'
  }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function addUsage(attributes: Record<string, unknown>, usage: TurnUsage): void {
  attributes[LLM_INPUT_TOKENS] = usage.input
  attributes[LLM_OUTPUT_TOKENS] = usage.output
  if (usage.reasoning !== undefined) attributes[LLM_REASONING_TOKENS] = usage.reasoning
  if (usage.costUsd !== undefined) attributes[LLM_COST_USD] = usage.costUsd
  if (usage.estimatedCostUsd !== undefined)
    attributes['braid.estimated_cost_usd'] = usage.estimatedCostUsd
  if (usage.latencyMs !== undefined) attributes['braid.llm_latency_ms'] = usage.latencyMs
  if (usage.model !== undefined) attributes[LLM_MODEL_NAME] = safeAnalysisText(usage.model)
  if (usage.tokensKnown === false) attributes['braid.tokens_complete'] = false
  if (usage.usdKnown === false) attributes['braid.cost_complete'] = false
  if (usage.promptCache !== undefined) {
    attributes['braid.prompt_cache'] = safeAnalysisValue(usage.promptCache)
    const cached = finite(usage.promptCache.read ?? usage.promptCache.cached)
    if (cached !== undefined) attributes[LLM_CACHED_TOKENS] = cached
  }
}

function publicEventPayload(event: BraidEvent): unknown {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (key === 'kind' || key === 'runId' || key === 'provider') continue
    payload[key] = value
  }
  return safeAnalysisValue(payload)
}

function addProviderMetadata(attributes: Record<string, unknown>, event: BraidEvent): void {
  if (!('provider' in event) || event.provider === undefined) return
  attributes['braid.provider_event_id'] = safeAnalysisText(event.provider.eventId)
  attributes['braid.provider_sequence'] = event.provider.providerSequence
  if (event.provider.cursor !== undefined)
    attributes['braid.provider_cursor'] = safeAnalysisText(event.provider.cursor)
  if (event.provider.occurredAt !== undefined)
    attributes['braid.provider_occurred_at'] = safeAnalysisText(event.provider.occurredAt)
  if (event.provider.receivedAt !== undefined)
    attributes['braid.provider_received_at'] = safeAnalysisText(event.provider.receivedAt)
}

function addRequestedRun(attributes: Record<string, unknown>, event: BraidEvent): void {
  if (event.kind !== 'run.requested') return
  attributes[INPUT_VALUE] = safeAnalysisText(event.text)
  const receipt = event.receipt
  if (receipt === undefined) return
  const profile = receipt.requested.profile
  const settings = profileModelSettings(profile)
  const model = receipt.requested.model ?? profile.model?.default
  const runner = receipt.requested.runner ?? profile.harness
  attributes['braid.profile_digest'] = receipt.profileDigest
  attributes['braid.agent_profile'] = safeAnalysisValue(profile)
  if (profile.name !== undefined) {
    attributes['agent.name'] = safeAnalysisText(profile.name)
    attributes['braid.profile_name'] = safeAnalysisText(profile.name)
  }
  if (model !== undefined) attributes[LLM_MODEL_NAME] = safeAnalysisText(model)
  if (runner !== undefined) attributes['braid.runner'] = safeAnalysisText(runner)
  if (receipt.provider !== undefined)
    attributes['braid.provider'] = safeAnalysisText(receipt.provider)
  if (receipt.requested.connectionId !== undefined)
    attributes['braid.connection_id'] = safeAnalysisText(receipt.requested.connectionId)
  if (receipt.environmentId !== undefined)
    attributes['braid.environment_id'] = safeAnalysisText(receipt.environmentId)
  if (receipt.providerSessionId !== undefined)
    attributes['braid.provider_session_id'] = safeAnalysisText(receipt.providerSessionId)
  if (settings.reasoningEffort !== undefined)
    attributes['braid.reasoning_effort'] = safeAnalysisText(settings.reasoningEffort)
  if (settings.maxOutputTokens !== undefined)
    attributes['braid.max_output_tokens'] = settings.maxOutputTokens
  attributes['braid.admission_status'] = receipt.admissionStatus ?? 'admitted'
  attributes['braid.capabilities'] = safeAnalysisValue(receipt.capabilities)
}

export function analysisEventError(event: BraidEvent): string | undefined {
  if (event.kind === 'run.error') return event.message
  if (event.kind === 'run.tool.result' && event.error !== undefined) return event.error
  if (event.kind === 'run.finished' && event.error !== undefined) return event.error
  if (event.kind === 'run.status.changed' && event.error !== undefined) return event.error
  if (event.kind === 'run.reconciled' && event.status === 'failed') return event.detail
  return undefined
}

export function analysisEventAttributes(
  frozen: FrozenAnalysisEvent,
  sourceDigest: string,
): Record<string, unknown> {
  const event = frozen.event
  const attributes: Record<string, unknown> = {
    'braid.event_id': String(frozen.id),
    'braid.kind': event.kind,
    'braid.source_digest': sourceDigest,
    [OPENINFERENCE_SPAN_KIND]:
      event.kind === 'run.text.delta' || event.kind === 'run.reasoning.delta' ? 'LLM' : 'AGENT',
    'braid.event_payload': publicEventPayload(event),
  }
  addProviderMetadata(attributes, event)
  addRequestedRun(attributes, event)

  switch (event.kind) {
    case 'run.text.delta':
    case 'run.reasoning.delta':
      attributes[OUTPUT_VALUE] = safeAnalysisText(event.text)
      break
    case 'run.part.updated':
      attributes['braid.message_part'] = safeAnalysisValue(event.part)
      if (event.delta !== undefined) attributes[OUTPUT_VALUE] = safeAnalysisText(event.delta)
      break
    case 'run.provider.event':
      attributes['braid.runtime_event_type'] = safeAnalysisText(event.envelope.event.type)
      attributes['braid.runtime_event'] = safeAnalysisValue(event.envelope.event)
      break
    case 'run.usage':
      addUsage(attributes, event.usage)
      break
    case 'run.cost':
      attributes[LLM_COST_USD] = event.costUsd
      break
    case 'run.artifact':
      attributes['braid.artifact_id'] = safeAnalysisText(event.artifactId)
      if (event.name !== undefined) attributes['braid.artifact_name'] = safeAnalysisText(event.name)
      if (event.mimeType !== undefined)
        attributes['braid.artifact_mime_type'] = safeAnalysisText(event.mimeType)
      if (event.uri !== undefined) attributes['braid.artifact_uri'] = safeAnalysisText(event.uri)
      if (event.metadata !== undefined)
        attributes['braid.artifact_metadata'] = safeAnalysisValue(event.metadata)
      break
    case 'run.environment.observed':
      attributes['braid.environment'] = safeAnalysisValue(event.observation)
      if (event.observation.providerEnvironmentId !== undefined)
        attributes['braid.environment_id'] = safeAnalysisText(
          event.observation.providerEnvironmentId,
        )
      attributes['braid.provider'] = safeAnalysisText(event.observation.provider)
      break
    case 'run.finished':
      attributes[OUTPUT_VALUE] = safeAnalysisText(event.finalText)
      attributes['braid.run_status'] = event.status
      addUsage(attributes, event.usage)
      if (event.reason !== undefined)
        attributes['braid.terminal_reason'] = safeAnalysisText(event.reason)
      break
    case 'run.status.changed':
    case 'run.reconciled':
      attributes['braid.run_status'] = event.status
      break
    default:
      break
  }

  const error = analysisEventError(event)
  if (error !== undefined) attributes['error.message'] = safeAnalysisText(error)
  return attributes
}
