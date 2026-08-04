import type { BraidApplication } from '../../app/application.js'
import type { BraidState } from '../../domain/state.js'
import type {
  BraidIntent,
  BraidUiController,
  UiDispatchResult,
  UiEvent,
  UiSubscriber,
} from '../../views/shared/intents.js'
import type { BraidViewModel, HeadlessState } from '../../views/shared/models.js'
import { freezeView } from '../../views/shared/models.js'
import type {
  ProfileConnectionDispatchOptions,
  ProfileConnectionDispatchServices,
} from './profile-connection-dispatch.js'
import { capabilityMap } from './ui-capabilities.js'
import { errorResult } from './ui-dispatch-error.js'
import { FIXTURE_FORK, FIXTURE_INTERACTION, type UiFixture } from './ui-fixtures.js'
import { toEvent, toHeadlessState } from './ui-projection.js'
import { buildBraidViewModel, type UiAppearanceOptions } from './ui-view-model.js'

export type { UiAppearanceOptions, UiFixture }
export { buildBraidViewModel }

export class ApplicationUiController implements BraidUiController {
  #app: BraidApplication
  readonly #subscribers = new Set<UiSubscriber>()
  readonly #subscriptions = new Map<UiSubscriber, () => void>()
  readonly #appearance: UiAppearanceOptions
  readonly #fixture: UiFixture | undefined
  #profileConnections:
    | {
        readonly app: BraidApplication
        readonly value: Promise<ProfileConnectionDispatchServices>
      }
    | undefined
  #intentDispatcher: Promise<typeof import('./ui-dispatch.js').dispatchIntent> | undefined
  readonly #profileConnectionOptions: ProfileConnectionDispatchOptions
  #selectedSurface: BraidViewModel['selectedSurface'] = 'transcript'
  #interactionResolved = false
  #notice: string | undefined
  #forkPreview: BraidViewModel['forkPreview'] | undefined

  constructor(
    app: BraidApplication,
    appearance: UiAppearanceOptions = {},
    fixture?: UiFixture,
    profileConnectionOptions: ProfileConnectionDispatchOptions = {},
  ) {
    this.#app = app
    this.#appearance = Object.freeze({ ...appearance })
    this.#fixture = fixture
    this.#profileConnectionOptions = profileConnectionOptions
  }

  view(): BraidViewModel {
    const state = this.#app.state()
    const view = withRunUsage(
      buildBraidViewModel(
        state,
        this.#selectedSurface,
        this.#appearance,
        this.#app.canCancel(),
        this.#app.storageFailure(),
        this.#app.cleanupUncertain(),
      ),
      state,
    )
    const decorated = freezeView({
      ...view,
      ...(this.#notice === undefined ? {} : { notice: this.#notice, statusText: this.#notice }),
      ...(this.#forkPreview === undefined ? {} : { forkPreview: this.#forkPreview }),
    })
    const fixtureDecorated =
      this.#fixture === undefined
        ? decorated
        : freezeView({
            ...decorated,
            capabilities: capabilityMap(state, this.#app.canCancel(), this.#fixture),
          })
    if (this.#fixture === 'interaction' && !this.#interactionResolved) {
      return freezeView({
        ...fixtureDecorated,
        interactions: Object.freeze([FIXTURE_INTERACTION]),
      })
    }
    if (this.#fixture === 'fork') {
      return freezeView({
        ...fixtureDecorated,
        forkPreview: FIXTURE_FORK,
      })
    }
    return fixtureDecorated
  }

  state(): HeadlessState {
    return toHeadlessState(
      this.#app.state(),
      this.#app.storageFailure(),
      this.#app.cleanupUncertain(),
    )
  }

  events(): readonly UiEvent[] {
    return freezeView(this.#app.events().map(toEvent))
  }

  subscribe(subscriber: UiSubscriber): () => void {
    this.#subscribers.add(subscriber)
    const unsubscribeApp = this.#subscribeToApp(subscriber)
    this.#subscriptions.set(subscriber, unsubscribeApp)
    return () => {
      this.#subscriptions.get(subscriber)?.()
      this.#subscriptions.delete(subscriber)
      this.#subscribers.delete(subscriber)
    }
  }

  async replaceApplication(next: BraidApplication, workspace: string): Promise<void> {
    if (next === this.#app) return
    next.initialize(workspace)
    await next.whenDurable()
    const nextSubscriptions = new Map<UiSubscriber, () => void>()
    try {
      for (const subscriber of this.#subscribers) {
        nextSubscriptions.set(subscriber, this.#subscribeToApp(subscriber, next))
      }
      for (const unsubscribe of this.#subscriptions.values()) unsubscribe()
    } catch (error) {
      for (const unsubscribe of nextSubscriptions.values()) unsubscribe()
      throw error
    }
    this.#app = next
    this.#profileConnections = undefined
    this.#subscriptions.clear()
    for (const [subscriber, unsubscribe] of nextSubscriptions) {
      this.#subscriptions.set(subscriber, unsubscribe)
    }
    this.#notify()
  }

  async initialize(workspace: string): Promise<UiDispatchResult> {
    try {
      this.#app.initialize(workspace)
      await this.#app.whenDurable()
      return { kind: 'accepted', revision: this.#app.state().revision }
    } catch (error) {
      return errorResult(error)
    }
  }

  async dispatch(intent: BraidIntent): Promise<UiDispatchResult> {
    const app = this.#app
    try {
      const [dispatchIntent, profileConnections] = await Promise.all([
        this.#dispatcher(),
        this.#profileConnectionServices(),
      ])
      if (app !== this.#app) return this.dispatch(intent)
      const result = await dispatchIntent(intent, {
        app,
        profileConnections,
        fixture: this.#fixture,
        subscribers: this.#subscribers,
        view: () => this.view(),
        notify: () => this.#notify(),
        interactionResolved: () => this.#interactionResolved,
        markInteractionResolved: () => {
          this.#interactionResolved = true
        },
        setSelectedSurface: (surface) => {
          this.#selectedSurface = surface
        },
        setNotice: (notice) => {
          this.#notice = notice
        },
        setForkPreview: (preview) => {
          this.#forkPreview = preview
        },
      })
      if (result.kind === 'accepted' && result.notice !== undefined) this.#notice = result.notice
      if (result.kind === 'accepted' && result.notice !== undefined) this.#notify()
      return result
    } catch (error) {
      return errorResult(error)
    }
  }

  #dispatcher(): Promise<typeof import('./ui-dispatch.js').dispatchIntent> {
    this.#intentDispatcher ??= import('./ui-dispatch.js').then((module) => module.dispatchIntent)
    return this.#intentDispatcher
  }

  #profileConnectionServices(): Promise<ProfileConnectionDispatchServices> {
    const app = this.#app
    if (this.#profileConnections?.app === app) return this.#profileConnections.value
    const value = import('./profile-connection-dispatch.js').then((module) =>
      module.createProfileConnectionDispatchServices(app, this.#profileConnectionOptions),
    )
    this.#profileConnections = { app, value }
    return value
  }

  async waitForIdle(): Promise<BraidViewModel> {
    await this.#app.waitForIdle()
    return this.view()
  }

  #notify(): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(this.view())
      } catch {
        // Subscriber failures must not make an already-committed app swap fail.
      }
    }
  }

  #subscribeToApp(subscriber: UiSubscriber, app = this.#app): () => void {
    return app.subscribe((state, envelope) => {
      const event = toEvent(envelope)
      subscriber(
        withRunUsage(
          buildBraidViewModel(
            state,
            this.#selectedSurface,
            this.#appearance,
            app.canCancel(),
            app.storageFailure(),
            app.cleanupUncertain(),
          ),
          state,
        ),
        event,
      )
    })
  }
}

function withRunUsage(view: BraidViewModel, state: BraidState): BraidViewModel {
  const sourceById = new Map(state.runs.map((run) => [run.id, run]))
  const runs = view.runs.map((run) => {
    const source = sourceById.get(run.id)
    if (source === undefined) return run
    const usage = {
      ...(run.usage?.model === undefined ? {} : { model: run.usage.model }),
      ...(source.inputTokens > 0 ? { input: source.inputTokens } : {}),
      ...(source.outputTokens > 0 ? { output: source.outputTokens } : {}),
      ...(source.costUsd === undefined || source.costUsd <= 0 ? {} : { costUsd: source.costUsd }),
    }
    if (Object.keys(usage).length > 0) return { ...run, usage: Object.freeze(usage) }
    const runWithoutUsage = { ...run }
    delete runWithoutUsage.usage
    return runWithoutUsage
  })
  return freezeView({ ...view, runs: Object.freeze(runs) })
}

export function createApplicationUiController(
  app: BraidApplication,
  appearance: UiAppearanceOptions = {},
  fixture?: UiFixture,
  profileConnectionOptions: ProfileConnectionDispatchOptions = {},
): ApplicationUiController {
  return new ApplicationUiController(app, appearance, fixture, profileConnectionOptions)
}
