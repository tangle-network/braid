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
  readonly onSubmit: (request: Readonly<WorkspaceRequest> | undefined) => void
  readonly onCancel: () => void
  readonly requestRender?: () => void
}

/** Keyboard-first cloud workspace form with no provider-native fields. */
export class WorkspaceRequestForm extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #onSubmit: WorkspaceRequestFormOptions['onSubmit']
  readonly #onCancel: () => void
  readonly #requestRender: (() => void) | undefined
  readonly #fixedRequest: Readonly<Pick<WorkspaceRequest, 'environment' | 'image'>>
  readonly #inputs = new Map<WorkspaceField, Input>()
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
      cwd: options.initialRequest?.cwd ?? '',
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
      ...(cwd === '' ? (hasWorkspaceSource ? { cwd: '.' } : {}) : { cwd }),
    }
    try {
      this.#onSubmit(snapshotWorkspaceRequest(request))
    } catch (error) {
      this.#error = workspaceRequestErrorMessage(error)
      this.#fieldIndex = errorFieldIndex(this.#error)
      this.#redraw()
    }
  }

  #trimmed(field: WorkspaceField): string {
    return this.#values[field].trim()
  }

  #syncFocus(): void {
    for (const input of this.#inputs.values()) input.focused = false
    if (!this.#focused || this.#closed) return
    const field = WORKSPACE_FIELDS[this.#fieldIndex]
    if (field !== undefined) {
      const input = this.#inputs.get(field)
      if (input !== undefined) input.focused = true
    }
  }

  #render(): void {
    this.#syncFocus()
    this.clear()
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
