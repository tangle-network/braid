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

  constructor(app: BraidApplication, appearance: UiAppearanceOptions = {}, fixture?: UiFixture) {
    this.#app = app
    this.#appearance = Object.freeze({ ...appearance })
    this.#fixture = fixture
  }

  view(): BraidViewModel {
    const state = this.#app.state()
    const view = buildBraidViewModel(
      state,
      this.#selectedSurface,
      this.#appearance,
      this.#app.canCancel(),
    )
    if (this.#fixture === 'interaction' && !this.#interactionResolved) {
      return freezeView({
        ...view,
        interactions: Object.freeze([FIXTURE_INTERACTION]),
        capabilities: capabilityMap(state, this.#app.canCancel(), this.#fixture),
      })
    }
    if (this.#fixture === 'fork') {
      return freezeView({
        ...view,
        forkPreview: FIXTURE_FORK,
        capabilities: capabilityMap(state, this.#app.canCancel(), this.#fixture),
      })
    }
    return view
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
      subscriber(
        buildBraidViewModel(state, this.#selectedSurface, this.#appearance, this.#app.canCancel()),
        event,
      )
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
}

export function createApplicationUiController(
  app: BraidApplication,
  appearance: UiAppearanceOptions = {},
  fixture?: UiFixture,
): ApplicationUiController {
  return new ApplicationUiController(app, appearance, fixture)
}
