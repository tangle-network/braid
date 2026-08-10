import {
  Container,
  CURSOR_MARKER,
  type Editor,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import type { BraidTheme } from './theme.js'

const MIN_USABLE_ROWS = 3
const COMPOSER_FRACTION = 0.4

type ComposerSourceView = Pick<
  BraidViewModel,
  'activeRunId' | 'capabilities' | 'queue' | 'queueCount'
>

export interface ComposerProjection {
  readonly action: 'send' | 'queue' | 'steer' | 'unavailable'
  readonly actionLabel: string
  readonly queuePosition?: number
  readonly hint: string
}

export interface ComposerViewOptions {
  readonly editor: Editor
  readonly rows: () => number
  readonly theme: BraidTheme
}

/** Projects the existing controller view into composer-only display state. */
export function composerProjectionFor(view: ComposerSourceView): ComposerProjection {
  const active = view.activeRunId !== undefined
  if (!active) {
    const send = view.capabilities['run.send']?.available === true
    return {
      action: send ? 'send' : 'unavailable',
      actionLabel: send ? 'send' : 'send unavailable',
      hint: 'alt+enter newline · paste',
    }
  }

  const queue = view.capabilities['run.queue']?.available === true
  const steer = view.capabilities['run.steer']?.available === true
  const queuePosition = queue ? nextQueuePosition(view) : undefined
  const queueLabel = queuePosition === undefined ? 'queue' : `queue next #${String(queuePosition)}`
  const actionLabel = queue
    ? steer
      ? `${queueLabel} · steer /steer`
      : queueLabel
    : steer
      ? 'steer /steer'
      : 'queue unavailable'

  return {
    action: queue ? 'queue' : steer ? 'steer' : 'unavailable',
    actionLabel,
    ...(queuePosition === undefined ? {} : { queuePosition }),
    hint: 'alt+enter newline · paste',
  }
}

function nextQueuePosition(view: ComposerSourceView): number | undefined {
  const positions = (view.queue ?? [])
    .map((entry) => entry.position)
    .filter((position) => Number.isSafeInteger(position) && position > 0)
  const largestKnown = positions.length > 0 ? Math.max(...positions) : view.queueCount
  if (!Number.isSafeInteger(largestKnown) || largestKnown < 0) return undefined
  return largestKnown + 1
}

/** Wraps Pi's editor without owning its text, focus, history, or paste state. */
export class ComposerView extends Container {
  readonly #editor: Editor
  readonly #rows: () => number
  readonly #theme: BraidTheme
  #projection: ComposerProjection = {
    action: 'send',
    actionLabel: 'send',
    hint: 'alt+enter newline · paste',
  }

  constructor(options: ComposerViewOptions) {
    super()
    this.#editor = options.editor
    this.#rows = options.rows
    this.#theme = options.theme
    this.addChild(this.#editor)
  }

  get editor(): Editor {
    return this.#editor
  }

  setView(view: ComposerSourceView): void {
    this.#projection = composerProjectionFor(view)
    this.invalidate()
  }

  override render(width: number): string[] {
    const lines = boundedEditorLines(this.#editor.render(width), this.#rows())
    if (lines.length === 0) return lines
    const last = lines.length - 1
    lines[0] = borderLabel(width, `› ${this.#projection.actionLabel}`, this.#theme)
    if (last > 1) lines[1] = promptBodyLine(lines[1], this.#theme)
    if (last > 0) lines[last] = borderLabel(width, this.#projection.hint, this.#theme)
    return lines
  }
}

function boundedEditorLines(lines: readonly string[], terminalRows: number): string[] {
  if (lines.length === 0) return []
  const budget = composerRowBudget(terminalRows)
  const top = lines[0] ?? ''
  const bottom = lines.at(-1) ?? ''
  const body = lines.slice(1, -1)
  const bodyBudget = Math.max(1, budget - 2)
  const minimumBodyRows = Math.min(MIN_USABLE_ROWS, bodyBudget)
  const visibleBodyRows = Math.min(bodyBudget, Math.max(minimumBodyRows, body.length))
  const bodyWidth = visibleWidth(body[0] ?? '')

  if (body.length === visibleBodyRows) return [...lines]

  const cursorIndex = body.findIndex((line) => line.includes(CURSOR_MARKER))
  const lastStart = Math.max(0, body.length - visibleBodyRows)
  const centeredStart = cursorIndex < 0 ? lastStart : cursorIndex - Math.floor(visibleBodyRows / 2)
  const start = Math.max(0, Math.min(centeredStart, lastStart))
  const boundedBody = body.slice(start, start + visibleBodyRows)
  const paddedBody = [
    ...boundedBody,
    ...Array.from({ length: Math.max(0, visibleBodyRows - boundedBody.length) }, () =>
      ' '.repeat(bodyWidth),
    ),
  ]
  return [top, ...paddedBody, bottom]
}

export function composerRowBudget(terminalRows: number): number {
  const safeRows = Math.max(1, Math.floor(terminalRows))
  return Math.min(safeRows, Math.max(MIN_USABLE_ROWS + 2, Math.floor(safeRows * COMPOSER_FRACTION)))
}

function borderLabel(width: number, label: string, theme: BraidTheme): string {
  const safeWidth = Math.max(1, Math.floor(width))
  const padded = truncateToWidth(` ${label} `, safeWidth, '…')
  const labelWidth = visibleWidth(padded)
  const remaining = Math.max(0, safeWidth - labelWidth)
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return `${theme.editor.borderColor('─'.repeat(left))}${theme.accent(padded)}${theme.editor.borderColor('─'.repeat(right))}`
}

function promptBodyLine(line: string | undefined, theme: BraidTheme): string {
  if (line === undefined || !line.startsWith(' ')) return line ?? ''
  return `${theme.accent('›')}${line.slice(1)}`
}
