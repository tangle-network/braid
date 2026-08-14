import {
  InteractionRequestSchema,
  interactionRequestDigest,
  type InteractionRequest,
  type InteractionRequestBinding,
  type InteractionRequestMaterial,
} from '@tangle-network/agent-interface'
import { canonicalDigest } from './canonical.js'
import { MAX_RUN_INTERACTIONS, withPendingInteractionIndex } from './reducer-support.js'
import type { BraidInteraction } from './runtime-projection.js'
import type { BraidState } from './state.js'
import { isCanonicalIsoDateTime } from './text.js'
import type { MaterializedState } from './materialized-state.js'

interface LegacyInteractionRecord {
  readonly id?: unknown
  readonly runId?: unknown
  readonly providerSessionId?: unknown
  readonly request?: unknown
  readonly status?: unknown
  readonly resolution?: unknown
  readonly createdAt?: unknown
}

type LegacyMaterializedState = MaterializedState & { readonly interactions?: unknown }

export function migrateLegacyInteractions(state: LegacyMaterializedState): MaterializedState {
  if (!Object.hasOwn(state, 'interactions')) return state
  if (!Array.isArray(state.interactions)) {
    throw new Error('Legacy snapshot interactions must be an array')
  }

  const { interactions: _legacyInteractions, ...withoutLegacyInteractions } = state
  if (state.interactions.length === 0) return withoutLegacyInteractions

  const seen = new Set<string>()
  const runs = [...state.runs]
  for (const raw of state.interactions) {
    const legacy = legacyInteractionRecord(raw)
    const id = requiredString(legacy.id, 'legacy interaction id')
    const runId = requiredString(legacy.runId, `legacy interaction ${id} runId`)
    if (!seen.add(id)) throw new Error(`Legacy snapshot interaction ${id} is duplicated`)
    const runIndex = runs.findIndex((run) => run.id === runId)
    if (runIndex === -1) throw new Error(`Legacy snapshot interaction ${id} has no run ${runId}`)
    const run = runs[runIndex]
    if (!run) throw new Error(`Legacy snapshot interaction ${id} has no run ${runId}`)
    const existing = run.interactions.find((interaction) => interaction.request.id === id)
    if (existing !== undefined) {
      assertLegacyInteractionMatches(legacy, existing)
      continue
    }
    if (run.pendingInteractionIds?.includes(id)) {
      throw new Error(`Legacy snapshot interaction ${id} conflicts with canonical pending identity`)
    }
    const migrated = migrateLegacyInteraction(legacy, run, id)
    const allInteractions = [...run.interactions, migrated]
    const indexed = withPendingInteractionIndex(run, allInteractions)
    runs[runIndex] = {
      ...indexed,
      interactions: allInteractions.slice(-MAX_RUN_INTERACTIONS),
      ...(allInteractions.length > MAX_RUN_INTERACTIONS ? { interactionsTruncated: true } : {}),
    }
  }
  return { ...withoutLegacyInteractions, runs }
}

function legacyInteractionRecord(value: unknown): LegacyInteractionRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Legacy snapshot interaction is not an object')
  }
  return value as LegacyInteractionRecord
}

function migrateLegacyInteraction(
  legacy: LegacyInteractionRecord,
  run: BraidState['runs'][number],
  id: string,
): BraidInteraction {
  const legacyRequest = recordValue(legacy.request, `legacy interaction ${id} request`)
  const request = legacyRequestWithBinding(legacyRequest, legacy, run, id)
  const status = legacyInteractionStatus(legacy.status, id)
  const responseOperation = legacyResponseOperation(legacy.resolution, status, id)
  if (status === 'responding' && responseOperation === undefined) {
    throw new Error(`Legacy snapshot interaction ${id} is responding without a response operation`)
  }
  return {
    request,
    responseBinding: { ...request.binding, requestDigest: request.requestDigest },
    runId: run.id,
    source: {
      ...(isCanonicalIsoDateTime(legacy.createdAt) ? { occurredAt: legacy.createdAt } : {}),
    },
    status,
    ...(responseOperation === undefined ? {} : { responseOperation }),
  }
}

function legacyRequestWithBinding(
  value: Record<string, unknown>,
  legacy: LegacyInteractionRecord,
  run: BraidState['runs'][number],
  id: string,
): InteractionRequest {
  const existing = InteractionRequestSchema.safeParse(value)
  if (existing.success) return existing.data as InteractionRequest
  const material = legacyRequestMaterial(value, legacy, run, id)
  const parsed = InteractionRequestSchema.safeParse({
    ...material,
    requestDigest: interactionRequestDigest(material),
  })
  if (!parsed.success) throw new Error(`Legacy snapshot interaction ${id} request is invalid`)
  return parsed.data as InteractionRequest
}

function legacyRequestMaterial(
  value: Record<string, unknown>,
  legacy: LegacyInteractionRecord,
  run: BraidState['runs'][number],
  id: string,
): InteractionRequestMaterial {
  const binding: InteractionRequestBinding = {
    runId: run.id,
    provider: providerIdentifier(run),
    environmentId:
      run.controlRef?.environmentId ??
      run.environmentId ??
      run.receipt.environmentId ??
      `legacy-environment-${run.id}`,
    sessionId:
      (typeof legacy.providerSessionId === 'string' ? legacy.providerSessionId : undefined) ??
      run.controlRef?.sessionId ??
      run.providerSessionId ??
      run.receipt.providerSessionId ??
      `legacy-session-${run.id}`,
    executionId: run.controlRef?.executionId ?? run.receipt.runId ?? run.id,
    interactionId: id,
  }
  const body = optionalString(value.body)
  const request = {
    id,
    kind: requiredString(value.kind, `legacy interaction ${id} kind`),
    title: requiredString(value.title, `legacy interaction ${id} title`),
    ...(body === undefined ? {} : { body }),
    ...(value.subject === undefined ? {} : { subject: value.subject }),
    answerSpec: value.answerSpec,
    ...(value.responseScopes === undefined ? {} : { responseScopes: value.responseScopes }),
    ...(value.allowedOutcomes === undefined ? {} : { allowedOutcomes: value.allowedOutcomes }),
    ...(value.default === undefined ? {} : { default: value.default }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    ...(value.onTimeout === undefined ? {} : { onTimeout: value.onTimeout }),
    binding,
  }
  return request as InteractionRequestMaterial
}

function providerIdentifier(run: BraidState['runs'][number]): string {
  return run.controlRef?.provider ?? run.receipt.provider ?? 'legacy'
}

function legacyInteractionStatus(value: unknown, id: string): BraidInteraction['status'] {
  switch (value) {
    case 'pending':
    case 'responding':
    case 'declined':
    case 'cancelled':
    case 'resolved':
    case 'unknown':
      return value
    case 'expired':
    case 'conflict':
      return 'unknown'
    default:
      throw new Error(`Legacy snapshot interaction ${id} status is invalid`)
  }
}

function legacyResponseOperation(
  value: unknown,
  status: BraidInteraction['status'],
  id: string,
): NonNullable<BraidInteraction['responseOperation']> | undefined {
  if (value === undefined) return undefined
  const resolution = recordValue(value, `legacy interaction ${id} resolution`)
  const operationId = requiredString(
    resolution.operationId,
    `legacy interaction ${id} resolution operationId`,
  )
  const outcome = resolution.outcome
  if (outcome !== 'accepted' && outcome !== 'declined' && outcome !== 'cancelled') {
    throw new Error(`Legacy snapshot interaction ${id} resolution outcome is invalid`)
  }
  if (status === 'unknown') {
    throw new Error(`Legacy snapshot interaction ${id} has a resolution with unknown status`)
  }
  if (
    status === 'responding' &&
    outcome !== 'accepted' &&
    outcome !== 'declined' &&
    outcome !== 'cancelled'
  ) {
    throw new Error(`Legacy snapshot interaction ${id} resolution is invalid`)
  }
  const containsSecret = resolution.containsSecret
  if (typeof containsSecret !== 'boolean') {
    throw new Error(`Legacy snapshot interaction ${id} resolution secrecy is invalid`)
  }
  const dataDigest = resolution.dataDigest
  if (dataDigest !== undefined && typeof dataDigest !== 'string') {
    throw new Error(`Legacy snapshot interaction ${id} resolution digest is invalid`)
  }
  return {
    operationId: operationId as NonNullable<BraidInteraction['responseOperation']>['operationId'],
    outcome,
    ...(dataDigest === undefined ? {} : { dataDigest: dataDigest as `sha256:${string}` }),
    containsSecret,
  }
}

function assertLegacyInteractionMatches(
  legacy: LegacyInteractionRecord,
  current: BraidInteraction,
): void {
  const id = current.request.id
  const request = recordValue(legacy.request, `legacy interaction ${id} request`)
  for (const key of [
    'id',
    'kind',
    'title',
    'body',
    'subject',
    'answerSpec',
    'responseScopes',
    'allowedOutcomes',
    'default',
    'timeoutMs',
    'onTimeout',
    'binding',
    'requestDigest',
  ] as const) {
    if (
      request[key] !== undefined &&
      canonicalDigest(request[key]) !== canonicalDigest(current.request[key])
    ) {
      throw new Error(`Legacy snapshot interaction ${id} conflicts with canonical run state`)
    }
  }
  const status = legacyInteractionStatus(legacy.status, id)
  if (status !== current.status) {
    throw new Error(`Legacy snapshot interaction ${id} status conflicts with canonical run state`)
  }
  if (
    legacy.providerSessionId !== undefined &&
    legacy.providerSessionId !== current.request.binding.sessionId
  ) {
    throw new Error(`Legacy snapshot interaction ${id} binding conflicts with canonical run state`)
  }
  if (legacy.resolution !== undefined) {
    const migrated = legacyResponseOperation(legacy.resolution, status, id)
    if (
      migrated === undefined ||
      current.responseOperation === undefined ||
      canonicalDigest(migrated) !== canonicalDigest(current.responseOperation)
    ) {
      throw new Error(
        `Legacy snapshot interaction ${id} resolution conflicts with canonical run state`,
      )
    }
  } else if (current.responseOperation !== undefined) {
    throw new Error(
      `Legacy snapshot interaction ${id} resolution conflicts with canonical run state`,
    )
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
