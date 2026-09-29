import { Container, type Focusable } from '@earendil-works/pi-tui'
import {
  type ConfigurationSelection,
  ConfigurationSession,
  type ConfigurationSessionState,
} from '../../app/configuration-session.js'
import { redactSensitiveText } from '../../domain/redaction.js'
import {
  ConfigurationCredential,
  configurationNeedsCredential,
  mountConfigurationCredential,
  PreparedCredential,
} from './configuration-credential.js'
import { ConfigurationRecovery } from './configuration-recovery.js'
import type { ConfigurationWizardOptions } from './configuration-wizard-options.js'
import {
  APPLY_SELECTION,
  BACK_TO_CONNECTION,
  BACK_TO_PROFILE,
  BACK_TO_WORKSPACE,
  CANCEL_CONFIGURATION,
} from './configuration-wizard-presentation.js'
import {
  type ConfigurationStageControl,
  renderConfigurationStage,
} from './setup-stage-rendering.js'
import type { WorkspaceRequestForm } from './workspace-request-form.js'
import { mountWorkspaceRequestForm } from './workspace-request-workflow.js'

/** Keyboard-first profile, destination, credential, and review flow. */
export class ConfigurationWizard extends Container implements Focusable {
  readonly #theme: ConfigurationWizardOptions['theme']
  #session: ConfigurationSession
  readonly #onCommit: ConfigurationWizardOptions['onCommit']
  readonly #onComplete: ConfigurationWizardOptions['onComplete']
  readonly #onCancel: ConfigurationWizardOptions['onCancel']
  readonly #confirmation: ConfigurationWizardOptions['confirmation']
  #diagnostics: readonly string[]
  readonly #requestRender: (() => void) | undefined
  readonly #requiresCredential: ConfigurationWizardOptions['requiresCredential']
  readonly #onReload: ConfigurationWizardOptions['onReload']
  readonly #rows: () => number
  #reloading = false
  #closed = false
  #selector!: ConfigurationStageControl | ConfigurationCredential | WorkspaceRequestForm
  #focused = false
  #busy = false
  #commitError: string | undefined
  readonly #credential = new PreparedCredential()

  constructor(options: ConfigurationWizardOptions) {
    super()
    const current = options.current?.() ?? options
    this.#theme = options.theme
    this.#session = new ConfigurationSession(current)
    this.#onCommit = options.onCommit
    this.#onComplete = options.onComplete
    this.#onCancel = options.onCancel
    this.#confirmation = options.confirmation
    this.#diagnostics = Object.freeze([...(current.diagnostics ?? [])])
    this.#requestRender = options.requestRender
    this.#requiresCredential = options.requiresCredential
    this.#onReload = options.onReload
    this.#rows = options.rows ?? (() => 24)
    this.#renderStage(this.#session.state)
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    this.#selector.focused = value
  }

  goBack(): boolean {
    if (this.#selector instanceof ConfigurationRecovery && this.#selector.goBack()) return true
    this.#cancel()
    return true
  }

  dispose(): void {
    this.#closed = true
    if (!this.#busy || this.#reloading) this.#clearCredential()
  }

  handleInput(data: string): void {
    this.#selector.handleInput(data)
  }

  #renderStage(state: ConfigurationSessionState): void {
    this.#selector = renderConfigurationStage({
      container: this,
      session: this.#session,
      state,
      theme: this.#theme,
      ...(this.#confirmation === undefined ? {} : { confirmation: this.#confirmation }),
      rows: this.#rows,
      ...(this.#onReload === undefined ? {} : { onReload: this.#reload }),
      credentialPrepared: this.#credential.prepared,
      credentialCommitted: this.#credential.committed,
      diagnostics: this.#diagnostics,
      busy: this.#busy,
      ...(this.#commitError === undefined ? {} : { commitError: this.#commitError }),
      focused: this.#focused,
      onSelect: (value) => this.#select(value),
      onCancel: () => this.#cancel(),
      ...(this.#requestRender === undefined ? {} : { requestRender: this.#requestRender }),
    })
  }

  #select(value: string): void {
    if (this.#busy) return
    const state = this.#session.state
    if (value === CANCEL_CONFIGURATION) {
      if (state.connections.length === 0) {
        this.#commitError = 'No connections are available. Press ←/esc to leave setup.'
        this.#renderStage(state)
        return
      }
      this.#cancel()
      return
    }
    if (value === BACK_TO_PROFILE) {
      this.#clearCredential()
      this.#commitError = undefined
      this.#renderStage(this.#session.backTo('profile'))
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
      const next = this.#session.selectConnection(value)
      this.#commitError = next.error?.message
      if (next.error === undefined && next.step === 'workspace') this.#renderWorkspace()
      else if (
        next.error === undefined &&
        configurationNeedsCredential(this.#session, this.#requiresCredential)
      )
        this.#renderCredential(next)
      else this.#renderStage(next)
      return
    }
    if (state.step === 'workspace') return
    if (state.step !== 'confirm' && state.step !== 'complete') return
    if (value === BACK_TO_CONNECTION) {
      this.#clearCredential()
      this.#commitError = undefined
      this.#renderStage(this.#session.backTo('connection'))
      return
    }
    if (value === BACK_TO_WORKSPACE) {
      this.#clearCredential()
      this.#commitError = undefined
      this.#session.backTo('workspace')
      this.#renderWorkspace()
      return
    }
    if (value === APPLY_SELECTION) void this.#apply()
  }

  #reload = async (): Promise<void> => {
    if (this.#busy || this.#closed || this.#onReload === undefined) return
    this.#busy = true
    this.#reloading = true
    this.#commitError = undefined
    this.#renderStage(this.#session.state)
    try {
      const discovered = await this.#onReload()
      if (this.#closed) return
      this.#session = new ConfigurationSession(discovered)
      this.#diagnostics = Object.freeze([...discovered.diagnostics])
      if (discovered.profiles.length === 0) this.#commitError = 'No agents found. See diagnostics.'
    } catch (error) {
      if (this.#closed) return
      const detail = redactSensitiveText(
        error instanceof Error ? error.message : 'Discovery could not complete.',
        512,
      )
      this.#diagnostics = Object.freeze([...new Set([...this.#diagnostics, detail])])
      this.#commitError = 'Discovery failed. See diagnostics.'
    } finally {
      this.#busy = false
      this.#reloading = false
      if (!this.#closed) this.#renderStage(this.#session.state)
    }
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
      this.#credential.markCommitted()
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
    if (this.#busy && !this.#reloading) return
    this.#closed = true
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

  #renderWorkspace(): void {
    this.clear()
    this.#selector = mountWorkspaceRequestForm({
      session: this.#session,
      theme: this.#theme,
      focused: this.#focused,
      ...(this.#requestRender === undefined ? {} : { requestRender: this.#requestRender }),
      ...(this.#requiresCredential === undefined
        ? {}
        : { requiresCredential: this.#requiresCredential }),
      onInvalid: (next) => {
        this.#commitError = next.error?.message
        this.#renderWorkspace()
      },
      onCredential: (next) => this.#renderCredential(next),
      onComplete: (next) => {
        this.#commitError = undefined
        this.#renderStage(next)
      },
      onCancel: () => {
        this.#commitError = undefined
        this.#renderStage(this.#session.backTo('connection'))
      },
    })
    this.#selector.focused = this.#focused
    this.addChild(this.#selector)
    this.invalidate()
    this.#requestRender?.()
  }

  #clearCredential(): void {
    this.#credential.clear()
    if (this.#selector instanceof ConfigurationCredential) this.#selector.dispose()
  }
}
