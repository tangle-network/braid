import type { BraidState } from '../domain/state.js'
import type { ReconnectInput } from './application-ports.js'
import { AppError } from './errors.js'

interface ActiveReconnect {
  readonly operationId: string
  readonly completion: Promise<BraidState>
  readonly attached: () => boolean
  readonly onAttached: (callback: () => void) => void
}

/** One in-flight reconnect per run; a user's reconnect joins the automatic restart re-attach. */
export class ActiveReconnects {
  readonly #active = new Map<string, ActiveReconnect>()

  run(
    input: ReconnectInput,
    start: (input: ReconnectInput) => Promise<BraidState>,
  ): Promise<BraidState> {
    const existing = this.#active.get(input.runId)
    if (existing !== undefined) {
      if (
        existing.operationId !== input.operationId &&
        existing.operationId !== restartReattachOperation(input.runId)
      )
        throw new AppError(
          'RECONNECT_IN_PROGRESS',
          `Run ${input.runId} already has a reconnect operation`,
        )
      if (input.onAttached !== undefined) {
        if (existing.attached()) input.onAttached()
        else existing.onAttached(input.onAttached)
      }
      return existing.completion
    }
    let ready = false
    const listeners = new Set<() => void>()
    if (input.onAttached !== undefined) listeners.add(input.onAttached)
    const completion = start({
      ...input,
      onAttached: () => {
        ready = true
        for (const listener of listeners) listener()
        listeners.clear()
      },
    })
    const active = {
      operationId: input.operationId,
      completion,
      attached: () => ready,
      onAttached: (callback: () => void) => listeners.add(callback),
    }
    this.#active.set(input.runId, active)
    void completion
      .finally(() => {
        if (this.#active.get(input.runId) === active) this.#active.delete(input.runId)
      })
      .catch(() => undefined)
    return completion
  }

  /** Re-attaches a run left live by restart, as /reconnect would, without waiting for it. */
  static reattachAfterRestart(
    runId: string,
    reconnect: (input: ReconnectInput) => Promise<BraidState>,
  ): void {
    try {
      void reconnect({ runId, operationId: restartReattachOperation(runId) }).catch(() => undefined)
    } catch {
      // Another reconnect or process already owns this run's re-attach.
    }
  }
}

function restartReattachOperation(runId: string): string {
  return `restart-reattach:${runId}`
}
