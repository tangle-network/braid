import type { InteractionRequest } from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEventEnvelope } from '../domain/events.js'
import type { OperationId } from '../domain/ids.js'
import { createOperationId } from '../domain/ids.js'
import type { BraidInteraction } from '../domain/runtime-projection.js'
import type { BraidState } from '../domain/state.js'
import { interactionRequestDigest } from './automation-rule-validation.js'

export type InteractionAutomationTarget = BraidInteraction

export interface InteractionAutomationApplyInput {
  readonly operationId: OperationId
  readonly runId: string
  readonly interactionId: string
}

export interface InteractionAutomationCoordinatorOptions {
  readonly state: () => BraidState
  readonly events: () => readonly BraidEventEnvelope[]
  readonly apply: (input: InteractionAutomationApplyInput) => Promise<unknown>
  readonly onError?: (error: unknown, target: InteractionAutomationTarget) => void | Promise<void>
}

export function interactionAutomationOperationId(
  runId: string,
  request: InteractionRequest,
  rules: BraidState['rules'] = [],
): OperationId {
  return createOperationId(
    `operation-automation-interaction-${canonicalDigest({
      runId,
      interactionRequestDigest: interactionRequestDigest(request),
      policyDigest: automationPolicyDigest(rules),
    }).slice(0, 48)}`,
  )
}

export function automationPolicyDigest(rules: BraidState['rules']): string {
  return canonicalDigest(
    [...rules]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map(({ uses: _uses, ...definition }) => definition),
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
    const operationId = operationForTarget(target, this.#options.state(), this.#options.events())
    if (operationId === undefined) return Promise.resolve()
    const key = interactionKey(target.runId, target.request.id, operationId)
    const pending = this.#pending.get(key)
    if (pending !== undefined) return pending

    const work = this.#tail.then(() => this.#process(target, operationId))
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

  async whenIdle(): Promise<void> {
    await this.#tail
  }

  async #process(
    scheduled: InteractionAutomationTarget,
    scheduledOperationId: OperationId,
  ): Promise<void> {
    let target = scheduled
    try {
      const current = findInteraction(this.#options.state(), scheduled.runId, scheduled.request.id)
      if (current === undefined) return
      const currentOperationId = operationForTarget(
        current,
        this.#options.state(),
        this.#options.events(),
      )
      if (currentOperationId !== scheduledOperationId) return
      target = current
      await this.#options.apply({
        operationId: scheduledOperationId,
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

function interactionKey(runId: string, interactionId: string, operationId: string): string {
  return `${runId}\u0000${interactionId}\u0000${operationId}`
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

function operationForTarget(
  target: InteractionAutomationTarget,
  state: BraidState,
  events: readonly BraidEventEnvelope[],
): OperationId | undefined {
  const operationId = interactionAutomationOperationId(target.runId, target.request, state.rules)
  if (target.status === 'pending') return operationId
  if (target.status !== 'responding') return undefined
  return requestedResponseOperation(events, target) === operationId ? operationId : undefined
}

function requestedResponseOperation(
  events: readonly BraidEventEnvelope[],
  target: InteractionAutomationTarget,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event
    if (
      event?.kind === 'run.interaction.response.requested' &&
      event.runId === target.runId &&
      event.interactionId === target.request.id
    )
      return event.operationId
  }
  return undefined
}
