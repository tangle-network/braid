import type { InteractionStatus, InteractionRecord } from '../domain/interaction-state.js'
import type { InteractionRuntimePort, ReconciledInteraction } from '../ports/interactions.js'
import { bindingForRecord } from './interaction-controller-utils.js'
import type { InteractionPersistence } from './interaction-persistence.js'

export class InteractionReconciliation {
  readonly #persistence: InteractionPersistence
  readonly #runtime: InteractionRuntimePort

  constructor(options: {
    readonly persistence: InteractionPersistence
    readonly runtime: InteractionRuntimePort
  }) {
    this.#persistence = options.persistence
    this.#runtime = options.runtime
  }

  async reconcile(
    input: { readonly runId?: string; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const records = this.#persistence
      .state()
      .interactions.filter(
        (interaction) =>
          (interaction.status === 'pending' || interaction.status === 'responding') &&
          (input.runId === undefined || interaction.runId === input.runId),
      )
    for (const record of records) {
      const result = await this.#one(record, input.signal)
      const current = this.#persistence
        .state()
        .interactions.find((interaction) => interaction.key === record.key)
      if (!current || (current.status !== 'pending' && current.status !== 'responding')) continue
      if (result.status === 'pending') continue
      const status = statusFromReconciliation(result)
      this.#persistence.commit({
        kind: 'interaction.resolved',
        key: record.key,
        status,
        ...(result.status === 'resolved' || result.reason === undefined
          ? {}
          : { reason: 'Provider reconciliation did not retain the interaction' }),
      })
    }
  }

  async #one(record: InteractionRecord, signal?: AbortSignal): Promise<ReconciledInteraction> {
    if (!this.#runtime.reconcileInteraction) {
      return { status: 'unknown', reason: 'The runtime cannot reconcile interaction state' }
    }
    return this.#runtime.reconcileInteraction({
      ...bindingForRecord(record),
      ...(signal === undefined ? {} : { signal }),
    })
  }
}

function statusFromReconciliation(
  result: ReconciledInteraction,
): Extract<InteractionStatus, 'resolved' | 'declined' | 'cancelled' | 'expired' | 'unknown'> {
  if (result.status === 'resolved') {
    return result.outcome === 'declined'
      ? 'declined'
      : result.outcome === 'cancelled'
        ? 'cancelled'
        : 'resolved'
  }
  return result.status === 'expired' || result.status === 'cancelled' ? result.status : 'unknown'
}
