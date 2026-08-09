import { Container, type Focusable, matchesKey, Text, TruncatedText } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { forkExecutionIdentity } from './conversation-overlay-helpers.js'
import type { BraidTheme } from './theme.js'

export interface ForkPreviewPanelOptions {
  readonly onConfirm?: () => void
  readonly onCancel?: () => void
}

export class ForkPreviewPanel extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #onConfirm: (() => void) | undefined
  readonly #onCancel: (() => void) | undefined
  readonly #error = new Text('', 1, 0)
  #focused = false
  #submitted = false
  #canConfirm = false

  constructor(theme: BraidTheme, options: ForkPreviewPanelOptions = {}) {
    super()
    this.#theme = theme
    this.#onConfirm = options.onConfirm
    this.#onCancel = options.onCancel
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
    this.#error.setText('')
    const preview = view.forkPreview
    if (!preview) {
      this.addChild(this.#line(this.#theme.brand('fork preview · unavailable')))
      this.addChild(this.#line(this.#theme.muted('No fork plan is available.')))
      this.addChild(
        this.#line(
          this.#theme.warning('Checkpoint and fork capabilities were not reported by the core.'),
        ),
      )
      this.addChild(this.#line(this.#theme.muted('esc cancel')))
    } else {
      this.#canConfirm = forkExecutionIdentity(preview) !== undefined
      this.addChild(
        this.#line(this.#theme.brand(`fork preview · ${sanitizeTerminalText(preview.kind)}`)),
      )
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
      const fields = preview.fields.filter(
        (field) => field !== boundaryField && !isExecutionField(field.label),
      )
      for (const field of fields.slice(0, 3)) {
        this.addChild(
          this.#line(
            `${sanitizeTerminalText(field.label)}: ${sanitizeTerminalText(field.source)} → ${sanitizeTerminalText(field.destination)}`,
          ),
        )
      }
      if (fields.length > 3)
        this.addChild(this.#line(this.#theme.muted(`+${fields.length - 3} fields not shown`)))
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
        this.addChild(this.#line(this.#theme.muted('esc cancel')))
      } else {
        this.addChild(this.#line(this.#theme.muted('enter/y create fork · esc cancel')))
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
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.#onCancel?.()
      return
    }
    if (this.#submitted || !this.#canConfirm || this.#onConfirm === undefined) return
    if (matchesKey(data, 'enter') || matchesKey(data, 'y')) {
      this.#submitted = true
      this.#onConfirm()
    }
  }

  #line(value: string): TruncatedText {
    return new TruncatedText(value, 1, 0)
  }
}

function isBoundaryField(label: string): boolean {
  return /boundary|context|through|message|turn/iu.test(sanitizeTerminalText(label))
}

function isExecutionField(label: string): boolean {
  return label === 'operation id' || label === 'plan digest'
}
