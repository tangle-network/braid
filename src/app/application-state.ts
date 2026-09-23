import type { AgentProfile } from '@tangle-network/agent-interface'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { reduceEvent } from '../domain/reducer.js'
import { type BraidState, initialState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import { AppError } from './errors.js'
import { MemoryJournal } from './journal.js'

export type ApplicationStateSubscriber = (
  state: BraidState,
  envelope: BraidEventEnvelope,
) => void

/** Owns the one in-process state and journal path shared by every application service. */
export class ApplicationStateStore {
  readonly #journal: MemoryJournal
  readonly #subscribers = new Set<ApplicationStateSubscriber>()
  #state: BraidState

  constructor(profile: Readonly<AgentProfile>, clock: Clock) {
    this.#journal = new MemoryJournal(clock)
    this.#state = initialState(structuredClone(profile))
  }

  state(): BraidState {
    return structuredClone(this.#state)
  }

  events(): readonly BraidEventEnvelope[] {
    return this.#journal.all()
  }

  subscribe(subscriber: ApplicationStateSubscriber): () => void {
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }

  initialize(workspace: string): BraidState {
    if (!workspace) throw new AppError('INVALID_WORKSPACE', 'Workspace must not be empty')
    if (this.#state.workspace === workspace) return this.state()
    if (this.#state.workspace !== null)
      throw new AppError('ALREADY_INITIALIZED', 'Braid is already initialized')
    this.commit({ kind: 'workspace.opened', workspace })
    return this.state()
  }

  commit(event: BraidEvent): void {
    const envelope = this.#journal.envelope(this.#state, event)
    const nextState = reduceEvent(this.#state, envelope)
    this.#journal.append(envelope)
    this.#state = nextState
    for (const subscriber of this.#subscribers)
      subscriber(this.state(), structuredClone(envelope))
  }
}
