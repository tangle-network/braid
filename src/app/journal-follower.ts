import type { BraidEventEnvelope } from '../domain/events.js'
import { providerEventKey } from '../domain/events.js'
import { reduceEvent } from '../domain/reducer.js'
import type { BraidState } from '../domain/state.js'
import type { TransitionHost } from './application-transition.js'

const FOLLOW_INTERVAL_MS = 250

export interface JournalFollowerOptions {
  /** A fresh copy of the state subscribers see: the viewer's conversation, if it opened one. */
  readonly view: () => BraidState
  readonly isClosed: () => boolean
  readonly fail: (error: unknown) => void
}

/**
 * A read-only viewer folds the events other Braid processes commit, four times a second, and
 * tells subscribers about each one as if this process had committed it. Each read takes the
 * journal's short transition lock, never a run's ownership lock.
 */
export class JournalFollower {
  readonly #host: TransitionHost
  readonly #options: JournalFollowerOptions
  readonly #timer: ReturnType<typeof setInterval>
  #reading: Promise<void> | undefined

  constructor(host: TransitionHost, options: JournalFollowerOptions) {
    this.#host = host
    this.#options = options
    this.#timer = setInterval(() => {
      if (this.#reading !== undefined || options.isClosed()) return
      this.#reading = this.#read().finally(() => {
        this.#reading = undefined
      })
    }, FOLLOW_INTERVAL_MS)
    this.#timer.unref()
  }

  /** Stops following and resolves once a read in progress has settled. */
  async stop(): Promise<void> {
    clearInterval(this.#timer)
    await this.#reading
  }

  async #read(): Promise<void> {
    const host = this.#host
    const withTransition = host.journal.withTransition?.bind(host.journal)
    if (withTransition === undefined) return
    try {
      const foreign = await withTransition(async (events: readonly BraidEventEnvelope[]) => events)
      for (const envelope of foreign) {
        host.setState(reduceEvent(host.state(), envelope))
        const key = providerEventKey(envelope.event)
        if (key) host.providerEventKeys.addProviderEvent(key)
        for (const subscriber of host.subscribers) {
          try {
            subscriber(this.#options.view(), structuredClone(envelope))
          } catch {
            // A renderer cannot change what another process committed.
          }
        }
      }
    } catch (error) {
      if (this.#options.isClosed()) return
      clearInterval(this.#timer)
      this.#options.fail(error)
    }
  }
}
