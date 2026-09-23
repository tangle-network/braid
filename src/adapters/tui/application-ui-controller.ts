import type { BraidApplication } from '../../app/application.js'
import type {
  BraidIntent,
  BraidUiController,
  UiDispatchResult,
  UiEvent,
  UiSubscriber,
} from '../../views/shared/intents.js'
import type { BraidViewModel, HeadlessState } from '../../views/shared/models.js'
import { freezeView } from '../../views/shared/models.js'
import {
  capabilityMap,
  FIXTURE_FORK,
  FIXTURE_INTERACTION,
  type UiFixture,
} from './ui-capabilities.js'
import { dispatchIntent, errorResult } from './ui-dispatch.js'
import { applyUiFixture } from './ui-fixtures.js'
import { toEvent, toHeadlessState } from './ui-projection.js'
import { buildBraidViewModel, type UiAppearanceOptions } from './ui-view-model.js'

export { buildBraidViewModel }
export type { UiAppearanceOptions, UiFixture }

export class ApplicationUiController implements BraidUiController {
  readonly #app: BraidApplication
  readonly #subscribers = new Set<UiSubscriber>()
  readonly #appearance: UiAppearanceOptions
  readonly #fixture: UiFixture | undefined
  #selectedSurface: BraidViewModel['selectedSurface'] = 'transcript'
  #interactionResolved = false
  #demoStage: NonNullable<BraidViewModel['demoStage']> = 'profile'
  #demoTimer: ReturnType<typeof setTimeout> | undefined

  constructor(app: BraidApplication, appearance: UiAppearanceOptions = {}, fixture?: UiFixture) {
    this.#app = app
    this.#appearance = Object.freeze({ ...appearance })
    this.#fixture = fixture
  }

  view(): BraidViewModel {
    const state = this.#app.state()
    const baseView = buildBraidViewModel(
      state,
      this.#selectedSurface,
      this.#appearance,
      this.#app.canCancel(),
    )
    if (!this.#fixture) return baseView
    const fixtureView = applyUiFixture(
      freezeView({
        ...baseView,
        capabilities: capabilityMap(state, this.#app.canCancel(), this.#fixture),
      }),
      this.#fixture,
      this.#demoStage,
    )
    const interactions = this.#interactionResolved
      ? Object.freeze([])
      : this.#fixture === 'interaction'
        ? Object.freeze([FIXTURE_INTERACTION])
        : fixtureView.interactions
    if (this.#fixture === 'fork') {
      return freezeView({ ...fixtureView, forkPreview: FIXTURE_FORK, interactions })
    }
    return freezeView({ ...fixtureView, interactions })
  }

  state(): HeadlessState {
    return toHeadlessState(this.#app.state())
  }

  events(): readonly UiEvent[] {
    return freezeView(this.#app.events().map(toEvent))
  }

  subscribe(subscriber: UiSubscriber): () => void {
    this.#subscribers.add(subscriber)
    const unsubscribeApp = this.#app.subscribe((state, envelope) => {
      const event = toEvent(envelope)
      void state
      subscriber(this.view(), event)
    })
    return () => {
      unsubscribeApp()
      this.#subscribers.delete(subscriber)
    }
  }

  async initialize(workspace: string): Promise<UiDispatchResult> {
    try {
      this.#app.initialize(workspace)
      return { kind: 'accepted', revision: this.#app.state().revision }
    } catch (error) {
      return errorResult(error)
    }
  }

  async dispatch(intent: BraidIntent): Promise<UiDispatchResult> {
    if (this.#fixture === 'demo') return this.#dispatchDemo(intent)
    return dispatchIntent(intent, {
      app: this.#app,
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
    })
  }

  async waitForIdle(): Promise<BraidViewModel> {
    await this.#app.waitForIdle()
    return this.view()
  }

  #notify(): void {
    for (const subscriber of this.#subscribers) subscriber(this.view())
  }

  #dispatchDemo(intent: BraidIntent): UiDispatchResult | Promise<UiDispatchResult> {
    if (intent.type === 'open-surface') {
      this.#selectedSurface = intent.surface === 'settings' ? 'details' : intent.surface
      this.#notify()
      return { kind: 'accepted', revision: this.#app.state().revision }
    }
    if (intent.type === 'respond-interaction') {
      if (this.#demoStage !== 'permission') {
        return {
          kind: 'unavailable',
          code: 'CAPABILITY_UNAVAILABLE',
          reason: 'No response is waiting',
        }
      }
      this.#demoStage = 'fork'
      this.#notify()
      return {
        kind: 'accepted',
        operationId: intent.operationId,
        revision: this.#app.state().revision,
        completion: Promise.resolve(),
      }
    }
    if (intent.type === 'send') {
      this.#demoStage = 'streaming'
      this.#notify()
      if (this.#demoTimer) clearTimeout(this.#demoTimer)
      this.#demoTimer = setTimeout(() => {
        this.#demoTimer = undefined
        if (this.#demoStage !== 'streaming') return
        this.#demoStage = 'permission'
        this.#notify()
      }, 420)
      return {
        kind: 'accepted',
        operationId: intent.operationId,
        revision: this.#app.state().revision,
        completion: Promise.resolve(),
      }
    }
    if (
      intent.type === 'cancel-run' ||
      (intent.type === 'run-command' && intent.command === 'cancel')
    ) {
      this.#demoStage = 'cancelled'
      this.#notify()
      return {
        kind: 'accepted',
        ...(intent.type === 'cancel-run' ? { operationId: intent.operationId } : {}),
        revision: this.#app.state().revision,
      }
    }
    if (intent.type === 'run-command') {
      if (intent.command === 'profile' && this.#demoStage === 'profile')
        this.#demoStage = 'connection'
      else if (intent.command === 'connection' && this.#demoStage === 'connection')
        this.#demoStage = 'runner'
      else if (intent.command === 'runner' && this.#demoStage === 'runner')
        this.#demoStage = 'model'
      else if (intent.command === 'model' && this.#demoStage === 'model') this.#demoStage = 'effort'
      else if (intent.command === 'effort' && this.#demoStage === 'effort')
        this.#demoStage = 'prompt'
      else if (intent.command === 'fork')
        this.#demoStage = intent.args.includes('--confirm') ? 'fork-complete' : 'fork'
      else if (
        intent.command === 'ask' ||
        intent.command === 'analyze' ||
        intent.command === 'compare'
      )
        this.#demoStage = 'analysis'
      else if (intent.command === 'graph') this.#demoStage = 'graph'
      else if (intent.command === 'quit') return dispatchIntent(intent, this.#dispatchContext())
      this.#notify()
      return {
        kind: 'accepted',
        ...(intent.operationId ? { operationId: intent.operationId } : {}),
        revision: this.#app.state().revision,
      }
    }
    if (intent.type === 'shutdown') return dispatchIntent(intent, this.#dispatchContext())
    return dispatchIntent(intent, this.#dispatchContext())
  }

  #dispatchContext() {
    return {
      app: this.#app,
      fixture: this.#fixture,
      subscribers: this.#subscribers,
      view: () => this.view(),
      notify: () => this.#notify(),
      interactionResolved: () => this.#interactionResolved,
      markInteractionResolved: () => {
        this.#interactionResolved = true
      },
      setSelectedSurface: (surface: BraidViewModel['selectedSurface']) => {
        this.#selectedSurface = surface
      },
    }
  }
}

export function createApplicationUiController(
  app: BraidApplication,
  appearance: UiAppearanceOptions = {},
  fixture?: UiFixture,
): ApplicationUiController {
  return new ApplicationUiController(app, appearance, fixture)
}
