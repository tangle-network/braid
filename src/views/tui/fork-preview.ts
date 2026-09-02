import { Container, type Focusable, matchesKey, Text, TruncatedText } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { forkExecutionIdentity } from './conversation-overlay-helpers.js'
import { focusedSurfaceLines } from './focused-surface.js'
import type { BraidTheme } from './theme.js'

export interface ForkPreviewPanelOptions {
  readonly onConfirm?: () => void
  readonly onCancel?: () => void
  readonly rows?: () => number
}

export class ForkPreviewPanel extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #onConfirm: (() => void) | undefined
  readonly #onCancel: (() => void) | undefined
  readonly #rows: () => number
  readonly #error = new Text('', 1, 0)
  #title = 'fork preview'
  #context: string | undefined
  #footer = '←/esc cancel'
  #focused = false
  #submitted = false
  #canConfirm = false
  #scrollOffset = 0
  #lastBodyRows = 1
  #lastBodyLength = 0

  constructor(theme: BraidTheme, options: ForkPreviewPanelOptions = {}) {
    super()
    this.#theme = theme
    this.#onConfirm = options.onConfirm
    this.#onCancel = options.onCancel
    this.#rows = options.rows ?? (() => 12)
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
  }

  setView(view: BraidViewModel): void {
    this.clear()
    this.#submitted = false
    this.#canConfirm = false
    this.#scrollOffset = 0
    this.#error.setText('')
    const preview = view.forkPreview
    if (!preview) {
      this.#title = 'fork preview · unavailable'
      this.#context = undefined
      this.#footer = '←/esc cancel'
      this.addChild(this.#line(this.#theme.muted('No fork plan is available.')))
      this.addChild(
        this.#line(
          this.#theme.warning('Checkpoint and fork capabilities were not reported by the core.'),
        ),
      )
    } else {
      this.#canConfirm = forkExecutionIdentity(preview) !== undefined
      this.#title = 'fork preview'
      this.#context = sanitizeTerminalText(preview.kind)
      this.addChild(
        this.#line(
          this.#theme.muted(
            `will create a new ${sanitizeTerminalText(preview.kind)} from this source`,
          ),
        ),
      )
      this.addChild(this.#line(`source: ${sanitizeTerminalText(preview.source)}`))
      this.addChild(this.#line(`destination: ${sanitizeTerminalText(preview.destination)}`))

      const boundaryField = preview.fields.find((field) => isBoundaryField(field.label))
      this.addChild(
        this.#line(
          boundaryField
            ? `boundary: ${sanitizeTerminalText(boundaryField.source)} → ${sanitizeTerminalText(boundaryField.destination)}`
            : this.#theme.warning('boundary: not reported by the fork plan'),
        ),
      )
      const fields = preview.fields.filter((field) => field !== boundaryField)
      for (const field of fields) {
        this.addChild(
          this.#line(
            `${sanitizeTerminalText(field.label)}: ${sanitizeTerminalText(field.source)} → ${sanitizeTerminalText(field.destination)}`,
          ),
        )
      }
      const confidential = preview.plan?.confidential
      if (confidential?.requested === true) {
        const requirements = [
          confidential.tee === undefined
            ? 'provider-selected TEE'
            : sanitizeTerminalText(confidential.tee),
          ...(confidential.sealed === true ? ['sealed'] : []),
        ]
        this.addChild(this.#line(`confidential request: ${requirements.join(' · ')}`))
      }
      this.addChild(this.#error)
      if (!this.#canConfirm) {
        this.addChild(
          this.#line(
            this.#theme.warning(
              sanitizeTerminalText(
                preview.allowed
                  ? 'The fork plan is missing execution data; create a fresh preview'
                  : (preview.unavailableReason ?? 'Fork is unavailable'),
              ),
            ),
          ),
        )
        this.#footer = '←/esc cancel'
      } else {
        this.#footer = 'enter/y create fork · ←/esc cancel'
      }
    }
    this.invalidate()
  }

  setError(message: string): void {
    this.#submitted = false
    this.#error.setText(this.#theme.danger(sanitizeTerminalText(message)))
    this.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'left') || matchesKey(data, 'ctrl+c')) {
      this.#onCancel?.()
      return
    }
    if (this.#handleNavigation(data)) return
    if (this.#submitted || !this.#canConfirm || this.#onConfirm === undefined) return
    if (matchesKey(data, 'enter') || matchesKey(data, 'y')) {
      this.#submitted = true
      this.#onConfirm()
    }
  }

  override render(width: number): string[] {
    const rows = Math.max(4, Math.floor(this.#rows()))
    const bodyRows = Math.max(1, rows - 4)
    const body = super.render(width)
    this.#lastBodyRows = bodyRows
    this.#lastBodyLength = body.length
    const maximum = Math.max(0, body.length - bodyRows)
    this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maximum))
    const visible = body.slice(this.#scrollOffset, this.#scrollOffset + bodyRows)
    const position =
      body.length > bodyRows
        ? `↑/↓ inspect ${this.#scrollOffset + 1}-${this.#scrollOffset + visible.length}/${body.length}`
        : undefined
    const footer =
      position !== undefined && width < 60
        ? this.#canConfirm
          ? '↑/↓ inspect · enter/y create · ←/esc'
          : '↑/↓ inspect · ←/esc cancel'
        : [this.#footer, position].filter(Boolean).join(' · ')
    return focusedSurfaceLines({
      theme: this.#theme,
      title: this.#title,
      ...(this.#context === undefined ? {} : { context: this.#context }),
      body: visible,
      footer,
      width,
      rows,
    })
  }

  #handleNavigation(data: string): boolean {
    const maximum = Math.max(0, this.#lastBodyLength - this.#lastBodyRows)
    const page = Math.max(1, this.#lastBodyRows - 1)
    const previous = this.#scrollOffset
    if (matchesKey(data, 'up')) this.#scrollOffset -= 1
    else if (matchesKey(data, 'down')) this.#scrollOffset += 1
    else if (matchesKey(data, 'pageUp')) this.#scrollOffset -= page
    else if (matchesKey(data, 'pageDown')) this.#scrollOffset += page
    else if (matchesKey(data, 'home')) this.#scrollOffset = 0
    else if (matchesKey(data, 'end')) this.#scrollOffset = maximum
    else return false
    this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maximum))
    if (this.#scrollOffset !== previous) this.invalidate()
    return true
  }

  #line(value: string): TruncatedText {
    return new TruncatedText(value, 1, 0)
  }
}

function isBoundaryField(label: string): boolean {
  return /boundary|context|through|message|turn/iu.test(sanitizeTerminalText(label))
}
