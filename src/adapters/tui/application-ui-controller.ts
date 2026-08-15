import type { BraidApplication } from '../../app/application.js'
import type { BraidState } from '../../domain/state.js'
import type {
  BraidIntent,
  BraidUiController,
  UiDispatchResult,
  UiEvent,
  UiSubscriber,
  UiSubscriptionOptions,
} from '../../views/shared/intents.js'
import type { BraidViewModel, HeadlessState } from '../../views/shared/models.js'
import { freezeView } from '../../views/shared/models.js'
import { sessionUsageFor, usageForRun } from '../../views/shared/usage-projection.js'
import type {
  ProfileConnectionDispatchOptions,
  ProfileConnectionDispatchServices,
} from './profile-connection-dispatch.js'
import { capabilityMap } from './ui-capabilities.js'
import { errorResult } from './ui-dispatch-error.js'
import { FIXTURE_FORK, FIXTURE_INTERACTION, type UiFixture } from './ui-fixtures.js'
import { withIntelligenceResult } from './ui-intelligence-result-view.js'
import { interactionViews, toEvent, toHeadlessState } from './ui-projection.js'
import { createUiSubscriberDelivery, type UiSubscriberDelivery } from './ui-subscriber-delivery.js'
import { buildBraidViewModel, type UiAppearanceOptions } from './ui-view-model.js'

export type { UiAppearanceOptions, UiFixture }
export { buildBraidViewModel }

interface ActiveUiSubscription {
  readonly options: UiSubscriptionOptions
  readonly delivery: UiSubscriberDelivery
  unsubscribe(): void
}

interface UiSubscriberRegistration {
  readonly options: UiSubscriptionOptions
  active: ActiveUiSubscription
}

interface CachedViewState {
  readonly app: BraidApplication
  readonly revision: number
  readonly state: BraidState
}

export class ApplicationUiController implements BraidUiController {
  #app: BraidApplication
  readonly #subscribers = new Set<UiSubscriber>()
  readonly #subscriptions = new Map<UiSubscriber, UiSubscriberRegistration>()
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
  #graphQuery = ''
  #interactionResolved = false
  #notice: string | undefined
  #forkPreview: BraidViewModel['forkPreview'] | undefined
  #selectedIntelligenceData: unknown
  #viewStateCache: CachedViewState | undefined

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
    const app = this.#app
    const revision = app.revision()
    if (
      this.#viewStateCache === undefined ||
      this.#viewStateCache.app !== app ||
      this.#viewStateCache.revision !== revision
    ) {
      this.#viewStateCache = { app, revision, state: app.state() }
    }
    return this.#project(this.#viewStateCache.state, app)
  }

  #project(state: BraidState, app: BraidApplication): BraidViewModel {
    const canRespond = app.canRespondToInteractions(interactionViews(state)[0]?.runId)
    const view = withRunUsage(
      buildBraidViewModel(
        state,
        this.#selectedSurface,
        this.#appearance,
        app.canCancel(),
        app.storageFailure(),
        app.cleanupUncertain(),
        canRespond,
        this.#graphQuery,
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
            capabilities: capabilityMap(state, app.canCancel(), this.#fixture, canRespond),
          })
    const intelligenceDecorated =
      this.#selectedIntelligenceData === undefined
        ? fixtureDecorated
        : withIntelligenceResult(fixtureDecorated, this.#selectedIntelligenceData, {
            durableAnalyses: state.analyses,
            allowUnpersisted:
              this.#fixture === 'analysis' ||
              this.#fixture === 'comparison' ||
              this.#fixture === 'product-demo',
          })
    if (this.#fixture === 'interaction' && !this.#interactionResolved) {
      return freezeView({
        ...intelligenceDecorated,
        interactions: Object.freeze([FIXTURE_INTERACTION]),
      })
    }
    if (this.#fixture === 'fork') {
      return freezeView({
        ...intelligenceDecorated,
        forkPreview: FIXTURE_FORK,
      })
    }
    return intelligenceDecorated
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

  subscribe(subscriber: UiSubscriber, options: UiSubscriptionOptions = {}): () => void {
    this.#subscriptions.get(subscriber)?.active.unsubscribe()
    this.#subscribers.add(subscriber)
    const frozenOptions = Object.freeze({ ...options })
    const registration: UiSubscriberRegistration = {
      options: frozenOptions,
      active: this.#subscribeToApp(subscriber, frozenOptions),
    }
    this.#subscriptions.set(subscriber, registration)
    return () => {
      if (this.#subscriptions.get(subscriber) !== registration) return
      registration.active.unsubscribe()
      this.#subscriptions.delete(subscriber)
      this.#subscribers.delete(subscriber)
    }
  }

  async replaceApplication(next: BraidApplication, workspace: string): Promise<void> {
    if (next === this.#app) return
    next.initialize(workspace)
    await next.whenDurable()
    const nextSubscriptions = new Map<UiSubscriber, ActiveUiSubscription>()
    try {
      for (const subscriber of this.#subscribers) {
        const current = this.#subscriptions.get(subscriber)
        if (current !== undefined) {
          nextSubscriptions.set(subscriber, this.#subscribeToApp(subscriber, current.options, next))
        }
      }
    } catch (error) {
      for (const subscription of nextSubscriptions.values()) subscription.unsubscribe()
      throw error
    }
    for (const registration of this.#subscriptions.values()) registration.active.unsubscribe()
    this.#app = next
    this.#profileConnections = undefined
    this.#viewStateCache = undefined
    this.#selectedIntelligenceData = undefined
    this.#graphQuery = ''
    this.#interactionResolved = false
    this.#notice = undefined
    this.#forkPreview = undefined
    for (const [subscriber, subscription] of nextSubscriptions) {
      const registration = this.#subscriptions.get(subscriber)
      if (registration !== undefined) registration.active = subscription
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
    if (
      intent.type === 'run-command' &&
      (intent.command === 'ask' || intent.command === 'analyze' || intent.command === 'compare')
    ) {
      this.#selectedIntelligenceData = undefined
      this.#notify()
    }
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
        setSelectedSurface: (surface, query) => {
          this.#selectedSurface = surface
          if (surface === 'graph' && query !== undefined) this.#graphQuery = query
        },
        setNotice: (notice) => {
          this.#notice = notice
        },
        setForkPreview: (preview) => {
          this.#forkPreview = preview
        },
      })
      let notify = false
      if (result.kind === 'accepted' && result.notice !== undefined) {
        this.#notice = result.notice
        notify = true
      }
      if (
        result.kind === 'accepted' &&
        result.data !== undefined &&
        intent.type === 'run-command' &&
        (intent.command === 'ask' || intent.command === 'analyze' || intent.command === 'compare')
      ) {
        this.#selectedIntelligenceData = result.data
        notify = true
      }
      if (notify) this.#notify()
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

  close(): Promise<void> {
    return this.#app.close()
  }

  #notify(): void {
    for (const registration of this.#subscriptions.values()) {
      try {
        registration.active.delivery.refresh()
      } catch {
        // Subscriber failures must not make an already-committed app swap fail.
      }
    }
  }

  #subscribeToApp(
    subscriber: UiSubscriber,
    options: UiSubscriptionOptions,
    app = this.#app,
  ): ActiveUiSubscription {
    const delivery = createUiSubscriberDelivery({
      subscriber,
      options,
      currentView: () => this.view(),
      project: (state) => this.#project(state, app),
    })
    const unsubscribeApp = app.subscribe((state, envelope) => {
      delivery.push(state, toEvent(envelope))
    })
    return {
      options,
      delivery,
      unsubscribe: () => {
        unsubscribeApp()
        delivery.dispose()
      },
    }
  }
}

function withRunUsage(view: BraidViewModel, state: BraidState): BraidViewModel {
  const sourceById = new Map(state.runs.map((run) => [run.id, run]))
  const runs = view.runs.map((run) => {
    const source = sourceById.get(run.id)
    if (source === undefined) return run
    return {
      ...run,
      usage: Object.freeze(usageForRun(source, run.usage?.elapsedMs)),
    }
  })
  return freezeView({
    ...view,
    runs: Object.freeze(runs),
    sessionUsage: sessionUsageFor(state),
  })
}

export function createApplicationUiController(
  app: BraidApplication,
  appearance: UiAppearanceOptions = {},
  fixture?: UiFixture,
  profileConnectionOptions: ProfileConnectionDispatchOptions = {},
): ApplicationUiController {
  return new ApplicationUiController(app, appearance, fixture, profileConnectionOptions)
}
