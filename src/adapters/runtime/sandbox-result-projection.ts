import type { ExecutorFactory } from '@tangle-network/agent-runtime/kernel'
import {
  contentAddress,
  createSandboxToolPartState,
  mapExecutorResult,
  mapSandboxToolEvent,
} from '@tangle-network/agent-runtime/kernel'
import {
  collectAgentFinalMessageText,
  collectAgentResponseText,
  type SandboxEvent,
} from '@tangle-network/sandbox'
import { safeProviderDiagnostic, safePublicIdentifier } from '../../domain/provider-values.js'
import { BRAID_SANDBOX_INTERACTION_UNSUPPORTED } from '../../domain/runtime-diagnostics.js'

export interface SandboxTerminalOutcome {
  readonly status: 'completed' | 'failed' | 'aborted'
  readonly reason?: string
}

type NormalizedSandboxStatus = SandboxTerminalOutcome['status'] | 'interaction-required'

interface SandboxExecutorOutput {
  readonly events?: readonly SandboxEvent[]
  readonly estimatedCostUsd?: number
  readonly promptCache?: Readonly<Record<string, number | string>>
}

/** Project Runtime's buffered sandbox artifact into its standard terminal result shape. */
export function withSandboxResultProjection(
  factory: ExecutorFactory<unknown>,
): ExecutorFactory<unknown> {
  return (spec, context) =>
    mapExecutorResult(factory(spec, context), (result) => {
      const raw = sandboxOutput(result.out)
      const events = raw.events ?? []
      const content =
        collectAgentFinalMessageText([...events]) ?? collectAgentResponseText([...events]) ?? ''
      const toolCalls = sandboxToolCalls(events)
      const sandboxOutcome = terminalOutcome(events)
      const out = {
        content,
        sandboxOutcome,
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
        ...(raw.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: raw.estimatedCostUsd }),
        ...(raw.promptCache === undefined ? {} : { promptCache: raw.promptCache }),
      }
      return {
        outRef: contentAddress({ kind: 'braid-sandbox-turn', source: result.outRef, out }),
        out,
        ...(result.verdict === undefined ? {} : { verdict: result.verdict }),
      }
    })
}

/** Read only the outcome marker created by this module. */
export function sandboxTerminalOutcomeFromExecutorOutput(
  value: unknown,
): SandboxTerminalOutcome | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const outcome = (value as { readonly sandboxOutcome?: unknown }).sandboxOutcome
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) return undefined
  const status = (outcome as { readonly status?: unknown }).status
  if (!['completed', 'failed', 'aborted'].includes(String(status))) return undefined
  const reason = (outcome as { readonly reason?: unknown }).reason
  return Object.freeze({
    status: status as SandboxTerminalOutcome['status'],
    ...(typeof reason === 'string' && reason.length > 0 ? { reason } : {}),
  })
}

function sandboxOutput(value: unknown): SandboxExecutorOutput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Readonly<Record<string, unknown>>
  const events = Array.isArray(raw.events) ? raw.events.filter(isSandboxEvent) : undefined
  const estimatedCostUsd =
    typeof raw.estimatedCostUsd === 'number' && Number.isFinite(raw.estimatedCostUsd)
      ? raw.estimatedCostUsd
      : undefined
  const promptCache = publicPromptCache(raw.promptCache)
  return {
    ...(events === undefined ? {} : { events }),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    ...(promptCache === undefined ? {} : { promptCache }),
  }
}

function isSandboxEvent(value: unknown): value is SandboxEvent {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { readonly type?: unknown }).type === 'string' &&
    (value as { readonly data?: unknown }).data !== null &&
    typeof (value as { readonly data?: unknown }).data === 'object' &&
    !Array.isArray((value as { readonly data?: unknown }).data)
  )
}

function sandboxToolCalls(
  events: readonly SandboxEvent[],
): readonly Readonly<Record<string, unknown>>[] {
  const state = createSandboxToolPartState()
  return events.flatMap((event) =>
    mapSandboxToolEvent(event, state).flatMap((projected) =>
      projected.type === 'tool_call'
        ? [
            {
              ...(projected.toolCallId === undefined ? {} : { id: projected.toolCallId }),
              name: projected.toolName,
              arguments: projected.args ?? {},
            },
          ]
        : [],
    ),
  )
}

function terminalOutcome(events: readonly SandboxEvent[]): SandboxTerminalOutcome {
  let sawTerminal = false
  let interactionRequired = false
  let abortedReason: string | undefined
  let failedReason: string | undefined

  for (const event of events) {
    const type = event.type.toLowerCase()
    const status = normalizedStatus(event.data.status)
    const reason = eventReason(event.data)
    if (type === 'error') failedReason ??= reason ?? 'Sandbox agent reported an error'
    if (type === 'result' || type === 'done' || type === 'final') sawTerminal = true
    if (status === 'failed') failedReason ??= reason ?? 'Sandbox agent reported a failed turn'
    else if (status === 'aborted') abortedReason ??= reason ?? 'Sandbox agent aborted the turn'
    else if (status === 'interaction-required') interactionRequired = true
    if (eventRequiresInteraction(event)) interactionRequired = true
    if (event.data.success === false) {
      failedReason ??= reason ?? 'Sandbox agent reported a failed turn'
    }
    const failedTool = failedToolName(event.data.toolInvocations)
    if (failedTool !== undefined) failedReason ??= `Sandbox tool ${failedTool} failed`
  }

  if (interactionRequired) {
    return {
      status: 'failed',
      reason: BRAID_SANDBOX_INTERACTION_UNSUPPORTED,
    }
  }
  if (failedReason !== undefined) return { status: 'failed', reason: failedReason }
  if (abortedReason !== undefined) return { status: 'aborted', reason: abortedReason }
  if (!sawTerminal) {
    return { status: 'failed', reason: 'Sandbox agent stream ended without a terminal event' }
  }
  return { status: 'completed' }
}

function eventRequiresInteraction(event: SandboxEvent): boolean {
  const type = event.type.toLowerCase()
  if (type === 'interaction' || type === 'plan.submitted') return true
  if ([event.data.approval, event.data.plan, event.data.question].some(isRecord)) return true
  if (
    isRecord(event.data.outcome) &&
    normalizedStatus(event.data.outcome.type) === 'interaction-required'
  ) {
    return true
  }
  if (!Array.isArray(event.data.toolInvocations)) return false
  return event.data.toolInvocations.some(
    (invocation) =>
      isRecord(invocation) &&
      invocation.isError === true &&
      containsMarker(invocation.result, 'HUB_APPROVAL_REQUIRED'),
  )
}

function containsMarker(
  value: unknown,
  marker: string,
  depth = 0,
  seen: Set<object> = new Set(),
): boolean {
  if (typeof value === 'string') return value.includes(marker)
  if (depth >= 8 || (value !== null && typeof value === 'object' && seen.has(value))) return false
  if (value === null || typeof value !== 'object') return false
  seen.add(value)
  try {
    return Object.values(value).some((entry) => containsMarker(entry, marker, depth + 1, seen))
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizedStatus(value: unknown): NormalizedSandboxStatus | undefined {
  if (typeof value !== 'string') return undefined
  const status = value.trim().toLowerCase().replaceAll('-', '_')
  if (['success', 'succeeded', 'completed', 'complete', 'done', 'ok'].includes(status)) {
    return 'completed'
  }
  if (['failed', 'failure', 'error'].includes(status)) return 'failed'
  if (['cancelled', 'canceled', 'aborted'].includes(status)) return 'aborted'
  if (
    ['blocked', 'blocked_on_approval', 'awaiting_question', 'awaiting_plan_decision'].includes(
      status,
    )
  ) {
    return 'interaction-required'
  }
  return undefined
}

function eventReason(data: Readonly<Record<string, unknown>>): string | undefined {
  for (const value of [data.error, data.message, data.reason, data.errorMessage]) {
    const message =
      typeof value === 'string'
        ? value
        : value !== null && typeof value === 'object' && !Array.isArray(value)
          ? (value as { readonly message?: unknown }).message
          : undefined
    if (typeof message !== 'string' || message.trim().length === 0) continue
    const safe = safeProviderDiagnostic(message, '')
    if (safe.length > 0) return safe
  }
  return undefined
}

function failedToolName(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const tool = entry as { readonly isError?: unknown; readonly toolName?: unknown }
    if (tool.isError !== true) continue
    return safePublicIdentifier(tool.toolName) ?? 'operation'
  }
  return undefined
}

function publicPromptCache(value: unknown): Readonly<Record<string, number | string>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number | string] =>
      typeof entry[1] === 'string' || (typeof entry[1] === 'number' && Number.isFinite(entry[1])),
  )
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}
