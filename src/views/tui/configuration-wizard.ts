import { Container, type Focusable, Text } from '@earendil-works/pi-tui'
import {
  type ConfigurationEffectiveValues,
  type ConfigurationSelection,
  ConfigurationSession,
  type ConfigurationSessionOptions,
  type ConfigurationSessionState,
} from '../../app/configuration-session.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import {
  type ConfigurationCommit,
  ConfigurationCredential,
  configurationNeedsCredential,
  mountConfigurationCredential,
  PreparedCredential,
} from './configuration-credential.js'
import { ConfigurationReview } from './configuration-review.js'
import {
  APPLY_SELECTION,
  BACK_TO_CONNECTION,
  BACK_TO_PROFILE,
  CANCEL_CONFIGURATION,
  configurationExplanation,
  configurationFooter,
  configurationItems,
  configurationReviewSummaries,
  configurationTitle,
  DOWN_ARROW,
} from './configuration-wizard-presentation.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'

type ConfigurationControl = SearchableSelector | ConfigurationReview | ConfigurationCredential

export interface ConfigurationWizardOptions extends ConfigurationSessionOptions {
  readonly theme: BraidTheme
  readonly onCommit: ConfigurationCommit
  readonly onComplete: (selection: ConfigurationSelection) => void
  readonly onCancel: () => void
  readonly confirmation?: (selection: ConfigurationSelection) => ConfigurationEffectiveValues
  readonly diagnostics?: readonly string[]
  readonly requestRender?: () => void
  readonly requiresCredential?: (connection: ConfigurationSelection['connection']) => boolean
}

export type TerminalConfigurationOptions = ConfigurationSessionOptions &
  Pick<ConfigurationWizardOptions, 'onCommit'> & {
    readonly openOnStart?: boolean
    readonly confirmation?: ConfigurationWizardOptions['confirmation']
    readonly diagnostics?: readonly string[]
    readonly requiresCredential?: ConfigurationWizardOptions['requiresCredential']
  }

/** Keyboard-first profile, destination, credential, and review flow. */
export class ConfigurationWizard extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #session: ConfigurationSession
  readonly #onCommit: ConfigurationWizardOptions['onCommit']
  readonly #onComplete: ConfigurationWizardOptions['onComplete']
  readonly #onCancel: ConfigurationWizardOptions['onCancel']
  readonly #confirmation: ConfigurationWizardOptions['confirmation']
  readonly #diagnostics: readonly string[]
  readonly #requestRender: (() => void) | undefined
  readonly #requiresCredential: ConfigurationWizardOptions['requiresCredential']
  #selector: ConfigurationControl
  #focused = false
  #busy = false
  #commitError: string | undefined
  readonly #credential = new PreparedCredential()

  constructor(options: ConfigurationWizardOptions) {
    super()
    this.#theme = options.theme
    this.#session = new ConfigurationSession(options)
    this.#onCommit = options.onCommit
    this.#onComplete = options.onComplete
    this.#onCancel = options.onCancel
    this.#confirmation = options.confirmation
    this.#diagnostics = Object.freeze([...(options.diagnostics ?? [])])
    this.#requestRender = options.requestRender
    this.#requiresCredential = options.requiresCredential
    this.#selector = new SearchableSelector({
      title: 'configuration',
      items: [],
      theme: options.theme,
      onSelect: () => {},
      onCancel: () => this.#cancel(),
    })
    this.#renderStage(this.#session.state)
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    this.#selector.focused = value
  }

  handleInput(data: string): void {
    this.#selector.handleInput(data)
  }

  #renderStage(state: ConfigurationSessionState): void {
    this.clear()
    const applied = state.step === 'complete' && !this.#busy && this.#commitError === undefined
    const heading = new Text(this.#theme.brand('braid setup'), 1, 0)
    this.addChild(heading)
    if (state.step !== 'confirm' && state.step !== 'complete') {
      this.addChild(new Text(this.#theme.muted(configurationExplanation(state)), 1, 0))
      for (const diagnostic of this.#diagnostics) {
        this.addChild(
          new Text(this.#theme.warning(`notice · ${sanitizeTerminalText(diagnostic)}`), 1, 0),
        )
      }
    }
    if (this.#commitError !== undefined && state.step !== 'confirm' && state.step !== 'complete') {
      this.addChild(new Text(this.#theme.danger(sanitizeTerminalText(this.#commitError)), 1, 0))
    }
    if (state.step === 'confirm' || state.step === 'complete') {
      const summaries = configurationReviewSummaries(
        this.#session,
        state,
        this.#confirmation,
        this.#credential.prepared,
      )
      this.#selector = new ConfigurationReview({
        theme: this.#theme,
        summary: summaries.summary,
        compactSummary: summaries.compact,
        title: applied
          ? 'selection applied'
          : configurationTitle(state, this.#busy, this.#commitError),
        ...(this.#commitError === undefined ? {} : { error: this.#commitError }),
        items: applied
          ? [{ value: CANCEL_CONFIGURATION, label: 'Close', description: '←/esc close' }]
          : configurationItems(state, this.#busy, this.#commitError),
        onSelect: (item) => this.#select(item.value),
        onCancel: () => this.#cancel(),
      })
    } else {
      this.#selector = new SearchableSelector({
        title: configurationTitle(state, this.#busy, this.#commitError),
        items: configurationItems(state, this.#busy, this.#commitError),
        maxVisible: 4,
        theme: this.#theme,
        footer: configurationFooter(state, this.#busy),
        onSelect: (item) => this.#select(item.value),
        onCancel: () => this.#cancel(),
      })
    }
    this.#selector.focused = this.#focused
    this.#restoreSelection(state)
    this.addChild(this.#selector)
    this.invalidate()
    this.#requestRender?.()
  }

  #restoreSelection(state: ConfigurationSessionState): void {
    if (!(this.#selector instanceof SearchableSelector)) return
    const selectedValue =
      state.step === 'profile'
        ? state.selectedProfileId
        : state.step === 'connection'
          ? state.selectedConnectionId
          : undefined
    if (selectedValue === undefined) return
    const index = configurationItems(state, this.#busy, this.#commitError).findIndex(
      (item) => item.value === selectedValue,
    )
    for (let offset = 0; offset < index; offset += 1) this.#selector.handleInput(DOWN_ARROW)
  }

  #select(value: string): void {
    if (this.#busy) return
    const state = this.#session.state
    if (value === CANCEL_CONFIGURATION) {
      if (state.profiles.length === 0 || state.connections.length === 0) {
        this.#commitError =
          state.profiles.length === 0
            ? 'No AgentProfiles are available. Press ←/esc to leave setup.'
            : 'No connections are available. Press ←/esc to leave setup.'
        this.#renderStage(state)
        return
      }
      this.#cancel()
      return
    }
    if (state.step === 'profile') {
      this.#clearCredential()
      const next = this.#session.selectProfile(value)
      this.#commitError = next.error?.message
      this.#renderStage(next)
      return
    }
    if (state.step === 'connection') {
      if (value === BACK_TO_PROFILE) {
        this.#clearCredential()
        this.#commitError = undefined
        this.#renderStage(this.#session.backTo('profile'))
        return
      }
      const next = this.#session.selectConnection(value)
      this.#commitError = next.error?.message
      if (
        next.error === undefined &&
        configurationNeedsCredential(this.#session, this.#requiresCredential)
      )
        this.#renderCredential(next)
      else this.#renderStage(next)
      return
    }
    if (state.step !== 'confirm' && state.step !== 'complete') return
    if (value === BACK_TO_CONNECTION) {
      this.#clearCredential()
      this.#commitError = undefined
      this.#renderStage(this.#session.backTo('connection'))
      return
    }
    if (value === BACK_TO_PROFILE) {
      this.#clearCredential()
      this.#commitError = undefined
      this.#renderStage(this.#session.backTo('profile'))
      return
    }
    if (value === APPLY_SELECTION) void this.#apply()
  }

  async #apply(): Promise<void> {
    let selection: ConfigurationSelection
    try {
      selection = this.#session.state.selection ?? this.#session.confirm()
    } catch (error) {
      this.#commitError =
        error instanceof Error ? error.message : 'Choose both values before applying'
      this.#renderStage(this.#session.state)
      return
    }
    this.#busy = true
    this.#commitError = undefined
    this.#renderStage(this.#session.state)
    try {
      await this.#onCommit(selection, this.#credential.value)
      this.#clearCredential()
      this.#busy = false
      this.#renderStage(this.#session.state)
      this.#onComplete(selection)
    } catch (error) {
      this.#clearCredential()
      this.#busy = false
      this.#commitError =
        error instanceof Error ? error.message : 'The selection could not be applied'
      if (configurationNeedsCredential(this.#session, this.#requiresCredential))
        this.#renderCredential(this.#session.state)
      else this.#renderStage(this.#session.state)
    }
  }

  #cancel(): void {
    if (this.#busy) return
    this.#clearCredential()
    this.#session.cancel()
    this.#onCancel()
  }

  #renderCredential(state: ConfigurationSessionState): void {
    let selection: ConfigurationSelection
    try {
      selection = this.#session.previewSelection()
    } catch {
      this.#renderStage(state)
      return
    }
    this.#selector = mountConfigurationCredential({
      container: this,
      theme: this.#theme,
      connectionName: selection.connection.name,
      focused: this.#focused,
      ...(this.#requestRender === undefined ? {} : { requestRender: this.#requestRender }),
      ...(this.#commitError === undefined ? {} : { error: this.#commitError }),
      onSubmit: (credential) => {
        this.#credential.replace(credential)
        this.#commitError = undefined
        this.#renderStage(state)
      },
      onCancel: () => {
        this.#clearCredential()
        this.#commitError = undefined
        this.#renderStage(this.#session.backTo('connection'))
      },
    })
  }

  #clearCredential(): void {
    this.#credential.clear()
    if (this.#selector instanceof ConfigurationCredential) this.#selector.dispose()
  }
}
