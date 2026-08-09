import type { InteractionRequest } from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type { OperationId } from '../domain/ids.js'
import { createOperationId } from '../domain/ids.js'
import type { BraidInteraction } from '../domain/runtime-projection.js'
import type { BraidState } from '../domain/state.js'
import { interactionRequestDigest } from './automation-rule-validation.js'

export interface RecordedInteractionResponse {
  readonly requested?: {
    readonly operationId?: string
  }
}

export type InteractionAutomationTarget = BraidInteraction & {
  readonly response?: RecordedInteractionResponse
}

export interface InteractionAutomationApplyInput {
  readonly operationId: OperationId
  readonly runId: string
  readonly interactionId: string
}

export interface InteractionAutomationCoordinatorOptions {
  readonly state: () => BraidState
  readonly apply: (input: InteractionAutomationApplyInput) => Promise<unknown>
  readonly onError?: (error: unknown, target: InteractionAutomationTarget) => void | Promise<void>
}

export function interactionAutomationOperationId(
  runId: string,
  request: InteractionRequest,
): OperationId {
  return createOperationId(
    `operation-automation-interaction-${canonicalDigest({
      runId,
      interactionRequestDigest: interactionRequestDigest(request),
    }).slice(0, 48)}`,
  )
}

export class InteractionAutomationCoordinator {
  readonly #options: InteractionAutomationCoordinatorOptions
  readonly #pending = new Map<string, Promise<void>>()
  #tail: Promise<void> = Promise.resolve()

  constructor(options: InteractionAutomationCoordinatorOptions) {
    this.#options = options
  }

  schedule(target: InteractionAutomationTarget): Promise<void> {
    const key = interactionKey(target.runId, target.request.id)
    const pending = this.#pending.get(key)
    if (pending !== undefined) return pending

    const work = this.#tail.then(() => this.#process(target))
    this.#tail = work.catch(() => undefined)
    this.#pending.set(key, work)
    void work.then(
      () => this.#clearPending(key, work),
      () => this.#clearPending(key, work),
    )
    return work
  }

  async reconcile(): Promise<void> {
    const targets = this.#options
      .state()
      .runs.flatMap((run) => run.interactions as readonly InteractionAutomationTarget[])
    await Promise.all(targets.map((target) => this.schedule(target)))
  }

  async #process(scheduled: InteractionAutomationTarget): Promise<void> {
    let target = scheduled
    try {
      const current = findInteraction(this.#options.state(), scheduled.runId, scheduled.request.id)
      if (current === undefined || !isEligible(current)) return
      target = current
      await this.#options.apply({
        operationId: interactionAutomationOperationId(target.runId, target.request),
        runId: target.runId,
        interactionId: target.request.id,
      })
    } catch (error) {
      await this.#reportError(error, target)
    }
  }

  async #reportError(error: unknown, target: InteractionAutomationTarget): Promise<void> {
    if (this.#options.onError === undefined) return
    try {
      await this.#options.onError(error, target)
    } catch {
      // Error reporting must not stop later interaction work.
    }
  }

  #clearPending(key: string, work: Promise<void>): void {
    if (this.#pending.get(key) === work) this.#pending.delete(key)
  }
}

function interactionKey(runId: string, interactionId: string): string {
  return `${runId}\u0000${interactionId}`
}

function findInteraction(
  state: BraidState,
  runId: string,
  interactionId: string,
): InteractionAutomationTarget | undefined {
  const run = state.runs.find((candidate) => candidate.id === runId)
  return run?.interactions.find((candidate) => candidate.request.id === interactionId) as
    | InteractionAutomationTarget
    | undefined
}

function isEligible(target: InteractionAutomationTarget): boolean {
  if (target.status === 'pending') return true
  if (target.status !== 'responding') return false
  return (
    target.response?.requested?.operationId ===
    interactionAutomationOperationId(target.runId, target.request)
  )
}
