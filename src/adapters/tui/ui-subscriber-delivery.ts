import type { BraidState } from '../../domain/state.js'
import type {
  UiEvent,
  UiFrameTiming,
  UiSubscriber,
  UiSubscriptionOptions,
} from '../../views/shared/intents.js'
import type { BraidViewModel } from '../../views/shared/models.js'

const DEFAULT_FRAME_INTERVAL_MS = 16
const FRAME_DELTA_KINDS = new Set(['run.text.delta', 'run.reasoning.delta', 'run.part.updated'])

export interface UiSubscriberDelivery {
  push(state: BraidState, event: UiEvent): void
  refresh(): void
  dispose(): void
}

interface DeliveryInput {
  readonly subscriber: UiSubscriber
  readonly options: UiSubscriptionOptions
  readonly currentView: () => BraidViewModel
  readonly project: (state: BraidState) => BraidViewModel
}

export function createUiSubscriberDelivery(input: DeliveryInput): UiSubscriberDelivery {
  if (input.options.delivery !== 'frame') return new EventSubscriberDelivery(input)
  return new FrameSubscriberDelivery(input)
}

class EventSubscriberDelivery implements UiSubscriberDelivery {
  readonly #input: DeliveryInput
  #disposed = false

  constructor(input: DeliveryInput) {
    this.#input = input
  }

  push(state: BraidState, event: UiEvent): void {
    if (!this.#disposed) this.#input.subscriber(this.#input.project(state), event)
  }

  refresh(): void {
    if (!this.#disposed) this.#input.subscriber(this.#input.currentView())
  }

  dispose(): void {
    this.#disposed = true
  }
}

type PendingDelivery =
  | { readonly kind: 'state'; readonly state: BraidState; readonly event: UiEvent }
  | { readonly kind: 'current' }

class FrameSubscriberDelivery implements UiSubscriberDelivery {
  readonly #input: DeliveryInput
  readonly #intervalMs: number
  #disposed = false
  #lastDeliveredAt = Number.NEGATIVE_INFINITY
  #pending: PendingDelivery | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #firstQueuedAt = 0
  #queuedUpdates = 0

  constructor(input: DeliveryInput) {
    this.#input = input
    this.#intervalMs = normalizedFrameInterval(input.options.frameIntervalMs)
  }

  push(state: BraidState, event: UiEvent): void {
    const pending = { kind: 'state' as const, state, event }
    if (FRAME_DELTA_KINDS.has(event.kind)) this.#enqueue(pending)
    else this.#deliverNow(pending)
  }

  refresh(): void {
    this.#deliverNow({ kind: 'current' })
  }

  dispose(): void {
    this.#disposed = true
    this.#pending = undefined
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#queuedUpdates = 0
  }

  #enqueue(pending: PendingDelivery): void {
    if (this.#disposed) return
    if (this.#pending === undefined) this.#firstQueuedAt = performance.now()
    this.#queuedUpdates += 1
    this.#pending = pending
    if (this.#timer !== undefined) return
    const elapsed = performance.now() - this.#lastDeliveredAt
    const delay = Number.isFinite(elapsed) ? Math.max(0, this.#intervalMs - elapsed) : 0
    this.#timer = setTimeout(() => this.#flush(), delay)
  }

  #deliverNow(pending: PendingDelivery): void {
    if (this.#disposed) return
    if (this.#pending === undefined) this.#firstQueuedAt = performance.now()
    this.#queuedUpdates += 1
    this.#pending = pending
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#flush()
  }

  #flush(): void {
    this.#timer = undefined
    if (this.#disposed) return
    const pending = this.#pending
    const firstQueuedAt = this.#firstQueuedAt
    const queuedUpdates = this.#queuedUpdates
    this.#pending = undefined
    this.#queuedUpdates = 0
    if (pending === undefined) return
    const projectionStartedAt = performance.now()
    let projectedAt = projectionStartedAt
    let deliveredAt = projectionStartedAt
    try {
      if (pending.kind === 'state') {
        const view = this.#input.project(pending.state)
        projectedAt = performance.now()
        this.#input.subscriber(view, pending.event)
      } else {
        const view = this.#input.currentView()
        projectedAt = performance.now()
        this.#input.subscriber(view)
      }
    } catch {
      // A delayed renderer failure cannot alter a committed application transition.
    } finally {
      deliveredAt = performance.now()
      this.#lastDeliveredAt = deliveredAt
    }
    this.#observe({
      queuedUpdates,
      queueDelayMs: projectionStartedAt - firstQueuedAt,
      projectionMs: projectedAt - projectionStartedAt,
      subscriberMs: deliveredAt - projectedAt,
      totalMs: deliveredAt - firstQueuedAt,
      ...(pending.kind === 'state'
        ? { revision: pending.state.revision, eventSequence: pending.event.sequence }
        : {}),
    })
  }

  #observe(timing: UiFrameTiming): void {
    try {
      this.#input.options.onFrameTiming?.(Object.freeze(timing))
    } catch {
      // Diagnostics cannot alter terminal delivery.
    }
  }
}

function normalizedFrameInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_FRAME_INTERVAL_MS
  return Math.max(1, Math.min(1_000, Math.floor(value)))
}
