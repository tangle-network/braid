import {
  type Component,
  Container,
  type Focusable,
  getKeybindings,
  Input,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { WorkspaceRequest } from '@tangle-network/agent-interface'
import {
  type ConfigurationFileLifetime,
  type ConfigurationSelection,
  connectionWithFileLifetime,
} from '../../app/configuration-session.js'
import {
  compactWorkspaceRepositoryUrl,
  snapshotWorkspaceRequest,
  workspaceRequestErrorMessage,
} from '../../app/workspace-request.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

type WorkspaceField = 'repoUrl' | 'gitRef' | 'cwd'

const WORKSPACE_FIELDS: readonly WorkspaceField[] = ['repoUrl', 'gitRef', 'cwd']
const WORKSPACE_LABELS: Readonly<Record<WorkspaceField, string>> = {
  repoUrl: 'repo url',
  gitRef: 'git ref',
  cwd: 'start in (repo-relative)',
}

export interface WorkspaceRequestFormOptions {
  readonly theme: BraidTheme
  readonly initialRequest?: Readonly<WorkspaceRequest>
  readonly initialConnection?: ConfigurationSelection['connection']
  readonly onSubmit: (
    request: Readonly<WorkspaceRequest> | undefined,
    lifetime?: ConfigurationFileLifetime,
  ) => void
  readonly onCancel: () => void
  readonly requestRender?: () => void
}

/** Keyboard-first cloud workspace and connection-lifetime editor. Nothing is saved here. */
export class WorkspaceRequestForm extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #onSubmit: WorkspaceRequestFormOptions['onSubmit']
  readonly #onCancel: () => void
  readonly #requestRender: (() => void) | undefined
  readonly #fixedRequest: Readonly<Pick<WorkspaceRequest, 'environment' | 'image'>>
  readonly #inputs = new Map<WorkspaceField, Input>()
  readonly #connection: ConfigurationSelection['connection'] | undefined
  readonly #idleTtl = new Input()
  #lifecycle: ConfigurationFileLifetime['lifecycle']
  #lifetimePage = false
  #ttlFocused = false
  #values: Readonly<Record<WorkspaceField, string>>
  #fieldIndex = 0
  #focused = false
  #error: string | undefined
  #closed = false

  constructor(options: WorkspaceRequestFormOptions) {
    super()
    this.#theme = options.theme
    this.#onSubmit = options.onSubmit
    this.#onCancel = options.onCancel
    this.#requestRender = options.requestRender
    this.#connection = options.initialConnection
    this.#lifecycle = options.initialConnection?.providerOptions.lifecycle ?? 'ephemeral'
    this.#idleTtl.setValue(String(options.initialConnection?.providerOptions.idleTtlSeconds ?? 3600))
    this.#fixedRequest = Object.freeze({
      ...(options.initialRequest?.environment === undefined
        ? {}
        : { environment: options.initialRequest.environment }),
      ...(options.initialRequest?.image === undefined
        ? {}
        : { image: options.initialRequest.image }),
    })
    this.#values = Object.freeze({
      repoUrl: options.initialRequest?.repoUrl ?? '',
      gitRef: options.initialRequest?.gitRef ?? '',
      cwd: options.initialRequest?.cwd?.path ?? '',
    })
    for (const field of WORKSPACE_FIELDS) {
      const input = new Input()
      input.setValue(this.#values[field])
      this.#inputs.set(field, input)
    }
    this.#render()
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    this.#syncFocus()
  }

  handleInput(data: string): void {
    if (this.#closed) return
    const keybindings = getKeybindings()
    if (keybindings.matches(data, 'tui.select.cancel')) {
      this.#cancel()
      return
    }
    if (this.#lifetimePage) {
      this.#handleLifetime(data)
      return
    }
    if (matchesKey(data, 'ctrl+l') && this.#connection !== undefined) {
      this.#lifetimePage = true
      this.#redraw()
      return
    }
    if (matchesKey(data, 'shift+tab')) {
      if (this.#fieldIndex === 0) this.#cancel()
      else {
        this.#fieldIndex -= 1
        this.#redraw()
      }
      return
    }
    if (keybindings.matches(data, 'tui.input.tab')) {
      this.#nextField()
      return
    }
    if (keybindings.matches(data, 'tui.input.submit')) {
      this.#nextField()
      return
    }
    const field = WORKSPACE_FIELDS[this.#fieldIndex]
    const input = field === undefined ? undefined : this.#inputs.get(field)
    if (field === undefined || input === undefined) return
    input.handleInput(data)
    const value = sanitizeTerminalText(input.getValue())
    if (value !== input.getValue()) input.setValue(value)
    this.#values = Object.freeze({ ...this.#values, [field]: value })
    this.#error = undefined
    this.invalidate()
    this.#requestRender?.()
  }

  #handleLifetime(data: string): void {
    if (matchesKey(data, 'shift+tab')) {
      if (this.#ttlFocused) this.#ttlFocused = false
      else this.#lifetimePage = false
      this.#error = undefined
      this.#redraw()
      return
    }
    const keybindings = getKeybindings()
    if (
      keybindings.matches(data, 'tui.input.submit') ||
      keybindings.matches(data, 'tui.input.tab')
    ) {
      if (this.#lifecycle === 'retained' && !this.#ttlFocused) {
        this.#ttlFocused = true
        this.#redraw()
      } else this.#submit()
      return
    }
    if (this.#ttlFocused) {
      this.#idleTtl.handleInput(data)
      this.#idleTtl.setValue(sanitizeTerminalText(this.#idleTtl.getValue()))
    } else if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      this.#lifecycle = this.#lifecycle === 'ephemeral' ? 'retained' : 'ephemeral'
    }
    this.#error = undefined
    this.#redraw()
  }

  #nextField(): void {
    if (this.#fieldIndex < WORKSPACE_FIELDS.length - 1) {
      this.#fieldIndex += 1
      this.#redraw()
      return
    }
    this.#submit()
  }

  #submit(): void {
    const repoUrl = this.#trimmed('repoUrl')
    const gitRef = this.#trimmed('gitRef')
    const cwd = this.#trimmed('cwd')
    const hasWorkspaceSource =
      repoUrl !== '' || gitRef !== '' || Object.keys(this.#fixedRequest).length > 0
    const request = {
      ...this.#fixedRequest,
      ...(repoUrl === '' ? {} : { repoUrl }),
      ...(gitRef === '' ? {} : { gitRef }),
      ...(cwd === ''
        ? hasWorkspaceSource
          ? { cwd: { base: 'repository' as const, path: '.' } }
          : {}
        : { cwd: { base: 'repository' as const, path: cwd } }),
    }
    let snapshot: Readonly<WorkspaceRequest> | undefined
    try {
      snapshot = snapshotWorkspaceRequest(request)
    } catch (error) {
      this.#error = workspaceRequestErrorMessage(error)
      this.#fieldIndex = errorFieldIndex(this.#error)
      this.#lifetimePage = false
      this.#redraw()
      return
    }
    let lifetime: ConfigurationFileLifetime | undefined
    if (this.#connection !== undefined) {
      lifetime = {
        lifecycle: this.#lifecycle,
        ...(this.#lifecycle === 'retained'
          ? { idleTtlSeconds: Number(this.#idleTtl.getValue().trim()) }
          : {}),
      }
      try {
        connectionWithFileLifetime(this.#connection, lifetime)
      } catch {
        this.#error = 'Retained idle limit: 60..604800 whole seconds.'
        this.#lifetimePage = true
        this.#ttlFocused = this.#lifecycle === 'retained'
        this.#redraw()
        return
      }
    }
    try {
      this.#onSubmit(snapshot, lifetime)
    } catch (error) {
      this.#error = workspaceRequestErrorMessage(error)
      this.#redraw()
    }
  }

  #trimmed(field: WorkspaceField): string {
    return this.#values[field].trim()
  }

  #syncFocus(): void {
    for (const input of this.#inputs.values()) input.focused = false
    this.#idleTtl.focused = false
    if (!this.#focused || this.#closed) return
    if (this.#lifetimePage) {
      this.#idleTtl.focused = this.#ttlFocused
      return
    }
    const field = WORKSPACE_FIELDS[this.#fieldIndex]
    if (field !== undefined) {
      const input = this.#inputs.get(field)
      if (input !== undefined) input.focused = true
    }
  }

  #render(): void {
    this.#syncFocus()
    this.clear()
    if (this.#lifetimePage) {
      this.addChild(new Text(this.#theme.brand('files · lifetime'), 1, 0))
      for (const lifecycle of ['ephemeral', 'retained'] as const) {
        const selected = lifecycle === this.#lifecycle
        const label = `${selected ? '>' : ' '} ${lifecycle}`
        this.addChild(new Text(selected ? this.#theme.brand(label) : this.#theme.muted(label), 1, 0))
      }
      this.addChild(
        new Text(
          this.#theme.muted(
            this.#lifecycle === 'ephemeral'
              ? 'Files end with the sandbox. Not a backup.'
              : 'Keep files between tasks, until idle expiry.',
          ),
          1,
          0,
        ),
      )
      if (this.#lifecycle === 'retained') {
        this.addChild(new Text(this.#theme.muted('idle seconds (60..604800)'), 1, 0))
        if (this.#ttlFocused) this.addChild(this.#idleTtl)
        else this.addChild(new Text(this.#theme.muted(`> ${this.#idleTtl.getValue()}`), 1, 0))
      }
      if (this.#error !== undefined)
        this.addChild(new Text(this.#theme.danger(this.#error), 1, 0))
      this.addChild(new Text(this.#theme.muted('↑/↓ choose · enter · shift-tab back · esc'), 1, 0))
      this.invalidate()
      return
    }
    this.addChild(new Text(this.#theme.brand('workspace · cloud sandbox'), 1, 0))
    this.addChild(new Text(this.#theme.muted('blank = repository root'), 1, 0))
    for (const [index, field] of WORKSPACE_FIELDS.entries()) {
      this.addChild(new Text(this.#theme.muted(WORKSPACE_LABELS[field]), 1, 0))
      const input = this.#inputs.get(field)
      if (input !== undefined) {
        if (index === this.#fieldIndex) this.addChild(input)
        else this.addChild(new WorkspaceValue(this.#theme, field, this.#values[field]))
      }
      if (this.#error !== undefined && index === this.#fieldIndex) {
        this.addChild(new Text(this.#theme.danger(sanitizeTerminalText(this.#error)), 1, 0))
      }
    }
    if (this.#connection !== undefined) {
      const lifetime = this.#lifecycle === 'retained'
        ? `retained ${this.#idleTtl.getValue()}s idle`
        : 'ephemeral'
      this.addChild(new Text(this.#theme.muted(`files: ${lifetime} · ctrl+l edit`), 1, 0))
    }
    this.addChild(new Text(this.#theme.muted('tab/enter continues · shift-tab · esc'), 1, 0))
    this.invalidate()
  }

  #redraw(): void {
    this.#render()
    this.#requestRender?.()
  }

  #cancel(): void {
    if (this.#closed) return
    this.#closed = true
    this.#focused = false
    this.#syncFocus()
    this.#onCancel()
  }
}

function errorFieldIndex(message: string): number {
  if (message.startsWith('repoUrl')) return 0
  if (message.startsWith('gitRef')) return 1
  if (message.startsWith('cwd') || message.startsWith('start in')) return 2
  return WORKSPACE_FIELDS.length - 1
}

class WorkspaceValue implements Component {
  readonly #theme: BraidTheme
  readonly #field: WorkspaceField
  readonly #value: string

  constructor(theme: BraidTheme, field: WorkspaceField, value: string) {
    this.#theme = theme
    this.#field = field
    this.#value = value
  }

  invalidate(): void {}

  render(width: number): string[] {
    const full = `> ${sanitizeTerminalText(this.#value)}`
    if (visibleWidth(full) <= width) return [this.#theme.muted(full)]
    const compact =
      this.#field === 'repoUrl'
        ? (compactWorkspaceRepositoryUrl(this.#value)?.replace(/^https?:\/\//u, '') ?? full)
        : full
    return [this.#theme.muted(truncateToWidth(`> ${compact}`, Math.max(1, width), '…'))]
  }
}
