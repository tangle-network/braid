import type { InteractionStatus, InteractionRecord } from '../domain/interaction-state.js'
import type { InteractionRuntimePort, ReconciledInteraction } from '../ports/interactions.js'
import type { Clock } from '../ports/clock.js'
import { canonicalDigest } from '../domain/canonical.js'
import { answerSpecContainsSecret } from '../domain/interaction.js'
import { redactSensitiveText } from '../domain/bounds.js'
import { bindingForRecord } from './interaction-controller-utils.js'
import type { InteractionPersistence } from './interaction-persistence.js'

const UNCERTAIN: readonly InteractionStatus[] = [
  'pending',
  'responding',
  'unknown',
  'transport_error',
  'unknown_interaction',
  'unknown_run',
]

export class InteractionReconciliation {
  readonly #persistence: InteractionPersistence
  readonly #runtime: InteractionRuntimePort
  readonly #clock: Clock

  constructor(options: {
    readonly persistence: InteractionPersistence
    readonly runtime: InteractionRuntimePort
    readonly clock: Clock
  }) {
    this.#persistence = options.persistence
    this.#runtime = options.runtime
    this.#clock = options.clock
  }

  async reconcile(
    input: { readonly runId?: string; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const records = this.#persistence
      .state()
      .interactions.filter(
        (interaction) =>
          UNCERTAIN.includes(interaction.status) &&
          (input.runId === undefined || interaction.runId === input.runId),
      )
    for (const record of records) {
      const result = await this.#one(record, input.signal)
      const current = this.#persistence
        .state()
        .interactions.find((interaction) => interaction.key === record.key)
      if (!current || !UNCERTAIN.includes(current.status)) continue
      const identityError = identityErrorFor(result, record)
      if (identityError) {
        this.#persistence.commit({
          kind: 'interaction.resolved',
          key: record.key,
          status: 'identity_conflict',
          reason: identityError,
        })
        continue
      }
      if (result.status === 'pending') continue
      if (result.status === 'resolved' && result.outcome === undefined) {
        this.#persistence.commit({
          kind: 'interaction.resolved',
          key: record.key,
          status: 'identity_conflict',
          reason: 'Provider reconciliation omitted the durable response outcome',
        })
        continue
      }
      const status = statusFromReconciliation(result)
      const safeReason = answerSpecContainsSecret(record.request.answerSpec)
        ? undefined
        : result.reason === undefined
          ? undefined
          : redactSensitiveText(result.reason)
      this.#persistence.commit({
        kind: 'interaction.resolved',
        key: record.key,
        status,
        ...(result.status === 'resolved' && result.outcome !== undefined
          ? {
              resolution: {
                outcome: result.outcome,
                operationId: record.pendingResponse?.operationId ?? 'provider-reconciled',
                ...(record.pendingResponse?.responseDigest === undefined
                  ? {}
                  : { responseDigest: record.pendingResponse.responseDigest }),
                containsSecret: record.request.answerSpec.fields.some(
                  (field) => field.type === 'secret',
                ),
                resolvedAt: this.#clock.now(),
              },
            }
          : {}),
        ...(safeReason === undefined ? {} : { reason: safeReason }),
      })
    }
  }

  async #one(record: InteractionRecord, signal?: AbortSignal): Promise<ReconciledInteraction> {
    if (!this.#runtime.reconcileInteraction) {
      return {
        status: 'unknown',
        ...bindingForRecord(record),
        requestDigest: record.requestDigest ?? canonicalDigest(record.request),
        ...(record.pendingResponse?.operationId === undefined
          ? {}
          : { operationId: record.pendingResponse.operationId }),
        ...(record.pendingResponse?.responseDigest === undefined
          ? {}
          : { responseDigest: record.pendingResponse.responseDigest }),
        reason: 'The runtime cannot reconcile interaction state',
      }
    }
    try {
      return await this.#runtime.reconcileInteraction({
        ...bindingForRecord(record),
        ...(record.pendingResponse?.operationId === undefined
          ? {}
          : { operationId: record.pendingResponse.operationId }),
        requestDigest: record.requestDigest ?? canonicalDigest(record.request),
        ...(record.pendingResponse?.responseDigest === undefined
          ? {}
          : { responseDigest: record.pendingResponse.responseDigest }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      return {
        status: 'unknown',
        ...bindingForRecord(record),
        ...(record.pendingResponse?.operationId === undefined
          ? {}
          : { operationId: record.pendingResponse.operationId }),
        requestDigest: record.requestDigest ?? canonicalDigest(record.request),
        ...(record.pendingResponse?.responseDigest === undefined
          ? {}
          : { responseDigest: record.pendingResponse.responseDigest }),
        reason: 'Provider reconciliation failed',
      }
    }
  }
}

function identityErrorFor(
  result: ReconciledInteraction,
  record: InteractionRecord,
): string | undefined {
  if (result.runId !== record.runId) return 'Provider reconciliation run does not match'
  if (result.interactionId !== record.interactionId) {
    return 'Provider reconciliation interaction does not match'
  }
  if ((result.requestRevision ?? undefined) !== (record.requestRevision ?? undefined)) {
    return 'Provider reconciliation request revision does not match'
  }
  if ((result.providerSessionId ?? undefined) !== (record.providerSessionId ?? undefined)) {
    return 'Provider reconciliation session does not match'
  }
  if ((result.profileDigest ?? undefined) !== (record.profileDigest ?? undefined)) {
    return 'Provider reconciliation profile does not match'
  }
  if ((result.connectionId ?? undefined) !== (record.connectionId ?? undefined)) {
    return 'Provider reconciliation connection does not match'
  }
  if ((result.workspaceId ?? undefined) !== (record.workspaceId ?? undefined)) {
    return 'Provider reconciliation workspace does not match'
  }
  if ((result.conversationId ?? undefined) !== (record.conversationId ?? undefined)) {
    return 'Provider reconciliation conversation does not match'
  }
  if ((result.branchId ?? undefined) !== (record.branchId ?? undefined)) {
    return 'Provider reconciliation branch does not match'
  }
  if ((result.model ?? undefined) !== (record.model ?? undefined)) {
    return 'Provider reconciliation model does not match'
  }
  if ((result.runner ?? undefined) !== (record.runner ?? undefined)) {
    return 'Provider reconciliation runner does not match'
  }
  if (result.requestDigest !== (record.requestDigest ?? canonicalDigest(record.request)))
    return 'Provider reconciliation request does not match'
  if (record.pendingResponse) {
    if (result.operationId !== record.pendingResponse.operationId) {
      return 'Provider reconciliation operation does not match'
    }
    if (result.responseDigest !== record.pendingResponse.responseDigest) {
      return 'Provider reconciliation response does not match'
    }
  } else if (result.operationId !== undefined || result.responseDigest !== undefined) {
    return 'Provider reconciliation response identity is not expected'
  }
  return undefined
}

function statusFromReconciliation(
  result: ReconciledInteraction,
): Extract<
  InteractionStatus,
  | 'resolved'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'unknown'
  | 'unknown_interaction'
  | 'unknown_run'
  | 'transport_error'
> {
  if (result.status === 'resolved') {
    return result.outcome === 'declined'
      ? 'declined'
      : result.outcome === 'cancelled'
        ? 'cancelled'
        : 'resolved'
  }
  if (result.status === 'expired' || result.status === 'cancelled') return result.status
  if (result.status === 'unknown_interaction' || result.status === 'unknown_run')
    return result.status
  if (result.status === 'unknown') return 'unknown'
  if (result.status === 'missing') return 'unknown'
  return 'transport_error'
}
