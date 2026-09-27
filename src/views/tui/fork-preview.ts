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
      this.addChild(this.#line(this.#theme.muted('same conversation · new branch')))
      const addedScope = forkAdditionalScope(preview)
      if (addedScope !== undefined) this.addChild(this.#line(this.#theme.muted(addedScope)))
      this.#addForkIdentities(preview.source, preview.destination)

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

  #addForkIdentities(source: string, destination: string): void {
    const sourceIdentity = splitForkIdentity(source)
    const destinationIdentity = splitForkIdentity(destination)
    if (
      sourceIdentity !== undefined &&
      destinationIdentity !== undefined &&
      sourceIdentity.conversation === destinationIdentity.conversation
    ) {
      this.addChild(this.#line(`source: ${sourceIdentity.conversation}`))
      this.addChild(this.#line(`source branch: ${sourceIdentity.branch}`))
      this.addChild(this.#line(`destination branch: ${destinationIdentity.branch}`))
      return
    }
    this.#addIdentity('source', source, sourceIdentity)
    this.#addIdentity('destination', destination, destinationIdentity)
  }

  #addIdentity(
    label: 'source' | 'destination',
    value: string,
    identity: ReturnType<typeof splitForkIdentity>,
  ): void {
    if (identity === undefined) {
      this.addChild(this.#line(`${label}: ${sanitizeTerminalText(value)}`))
      return
    }
    this.addChild(this.#line(`${label}: ${identity.conversation}`))
    const branchLabel = label === 'source' ? 'source branch' : 'destination branch'
    this.addChild(this.#line(`${branchLabel}: ${identity.branch}`))
  }

  #line(value: string): TruncatedText {
    return new TruncatedText(value, 1, 0)
  }
}

function isBoundaryField(label: string): boolean {
  return /boundary|context|through|message|turn/iu.test(sanitizeTerminalText(label))
}

function forkAdditionalScope(
  preview: NonNullable<BraidViewModel['forkPreview']>,
): string | undefined {
  switch (preview.kind) {
    case 'conversation':
      return undefined
    case 'workspace':
      if (
        preview.allowed &&
        preview.plan?.environment === 'new' &&
        preview.plan.checkpoint === 'required'
      ) {
        return 'workspace: new environment from checkpoint'
      }
      if (!preview.allowed || preview.plan?.environment === 'unavailable') {
        return 'workspace: fork unavailable'
      }
      return 'workspace: checkpoint status unreported'
    case 'cross-runner':
      if (
        preview.allowed &&
        preview.plan?.environment === 'new' &&
        preview.plan.providerSession === 'new'
      ) {
        return 'runner: new session'
      }
      if (!preview.allowed || preview.plan?.environment === 'unavailable') {
        return 'runner: transfer unavailable'
      }
      return 'runner: transfer status unreported'
  }
}

function splitForkIdentity(value: string): { conversation: string; branch: string } | undefined {
  const delimiter = value.indexOf(' / ')
  if (delimiter === -1) return undefined
  return {
    conversation: sanitizeTerminalText(value.slice(0, delimiter)),
    branch: sanitizeTerminalText(value.slice(delimiter + 3)),
  }
}
