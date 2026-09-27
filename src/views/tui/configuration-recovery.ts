import {
  Container,
  type Focusable,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export interface ConfigurationRecoveryOptions {
  readonly theme: BraidTheme
  readonly diagnostics: readonly string[]
  readonly busy: boolean
  readonly canRetry: boolean
  readonly error?: string
  readonly rows: () => number
  readonly onRetry: () => void
  readonly onCancel: () => void
  readonly requestRender?: () => void
}

const SETUP_GUIDANCE = [
  'Local: install and sign in to Pi, Codex, or OpenCode. Start CLI Bridge in another terminal, then choose Retry discovery.',
  'Have a profile? Save it as .braid/profile.json or braid.profile.json in this workspace, then retry.',
  'For a profile elsewhere, leave setup and restart Braid with --profile <path>.',
  'Cloud: create a profile using the cloud setup guide, then retry.',
  'Setup guide: https://github.com/tangle-network/braid/blob/main/docs/getting-started.md',
]

/** Keeps recovery actions visible while setup details remain keyboard accessible. */
export class ConfigurationRecovery extends Container implements Focusable {
  readonly #options: ConfigurationRecoveryOptions
  readonly #list: SelectList
  #focused = false
  #page: 'actions' | 'guide' | 'diagnostics' = 'actions'
  #offset = 0
  #bodyRows = 1
  #bodyLength = 0

  constructor(options: ConfigurationRecoveryOptions) {
    super()
    this.#options = options
    this.#list = new SelectList(
      [
        ...(options.canRetry
          ? [{ value: 'retry', label: options.busy ? 'Checking for agents…' : 'Retry discovery' }]
          : []),
        { value: 'guide', label: 'Setup instructions' },
        { value: 'diagnostics', label: 'Show diagnostics' },
        { value: 'cancel', label: 'Leave setup' },
      ],
      4,
      options.theme.select,
    )
    this.#list.onSelect = (item) => {
      if (item.value === 'retry') {
        if (!options.busy) options.onRetry()
      } else if (item.value === 'cancel') options.onCancel()
      else if (item.value === 'guide' || item.value === 'diagnostics') {
        this.#page = item.value
        this.#offset = 0
        this.#redraw()
      }
    }
    this.#list.onCancel = options.onCancel
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
  }

  goBack(): boolean {
    if (this.#page === 'actions') return false
    this.#page = 'actions'
    this.#redraw()
    return true
  }

  handleInput(data: string): void {
    if (this.#page === 'actions') {
      if (matchesKey(data, 'left') || matchesKey(data, 'ctrl+c')) this.#options.onCancel()
      else this.#list.handleInput(data)
      return
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'left') || matchesKey(data, 'enter')) {
      this.goBack()
      return
    }
    if (matchesKey(data, 'ctrl+c')) {
      this.#options.onCancel()
      return
    }
    if (matchesKey(data, 'down')) this.#offset += 1
    else if (matchesKey(data, 'up')) this.#offset -= 1
    else if (matchesKey(data, 'pageDown')) this.#offset += this.#bodyRows
    else if (matchesKey(data, 'pageUp')) this.#offset -= this.#bodyRows
    else if (matchesKey(data, 'home')) this.#offset = 0
    else if (matchesKey(data, 'end')) this.#offset = this.#bodyLength
    else return
    this.#offset = Math.max(0, Math.min(this.#offset, this.#bodyLength - this.#bodyRows))
    this.#redraw()
  }

  override render(width: number): string[] {
    const { theme } = this.#options
    const rows = Math.max(6, Math.floor(this.#options.rows() * 0.9))
    const line = (text: string) => truncateToWidth(text, Math.max(1, width), '…')
    if (this.#page !== 'actions') {
      const messages =
        this.#page === 'guide'
          ? SETUP_GUIDANCE
          : this.#options.diagnostics.length > 0
            ? this.#options.diagnostics
            : ['Discovery returned no diagnostic details.']
      const body = new Text(messages.map(sanitizeTerminalText).join('\n\n'), 1, 0).render(width)
      this.#bodyRows = rows - 2
      this.#bodyLength = body.length
      this.#offset = Math.max(0, Math.min(this.#offset, body.length - this.#bodyRows))
      return [
        line(theme.brand(this.#page === 'guide' ? 'Setup instructions' : 'Discovery details')),
        ...body.slice(this.#offset, this.#offset + this.#bodyRows),
        line(
          theme.muted(
            width <= 44
              ? '↑↓ scroll · esc back'
              : `↑↓/PgUp/PgDn · ${this.#offset + 1}-${Math.min(body.length, this.#offset + this.#bodyRows)}/${body.length} · esc back`,
          ),
        ),
      ]
    }
    const summary =
      width <= 44
        ? ['Start CLI Bridge or add a profile.', 'Then choose Retry discovery.']
        : ['Start CLI Bridge in another terminal.', 'Or save .braid/profile.json, then retry.']
    return [
      line(theme.brand('Connect a coding agent to start')),
      ...summary.map((text, index) =>
        line(
          theme.muted(
            index === 1 && !this.#options.canRetry ? 'See setup instructions to continue.' : text,
          ),
        ),
      ),
      ...(this.#options.error === undefined
        ? []
        : [line(theme.danger(sanitizeTerminalText(this.#options.error)))]),
      ...this.#list.render(width),
      line(theme.muted('enter choose · ↑↓ move · esc leave')),
    ]
  }

  #redraw(): void {
    this.invalidate()
    this.#options.requestRender?.()
  }
}
