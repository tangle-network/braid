import {
  Container,
  CURSOR_MARKER,
  type Editor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import type { BraidTheme } from './theme.js'

const MIN_USABLE_ROWS = 3
const COMPOSER_FRACTION = 0.4

export type ComposerMode = 'queue' | 'steer'

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
export function composerProjectionFor(
  view: ComposerSourceView,
  preferredMode: ComposerMode = 'queue',
): ComposerProjection {
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
  const action =
    preferredMode === 'steer' && steer ? 'steer' : queue ? 'queue' : steer ? 'steer' : 'unavailable'
  const queuePosition = queue ? nextQueuePosition(view) : undefined
  const queueLabel = queuePosition === undefined ? 'queue' : `queue next #${String(queuePosition)}`
  const actionLabel =
    action === 'steer'
      ? queue
        ? 'steer now · Alt+S queue'
        : 'steer now'
      : action === 'queue'
        ? steer
          ? `${queueLabel} · Alt+S steer`
          : queueLabel
        : 'input unavailable'

  return {
    action,
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
  #mode: ComposerMode = 'queue'

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

  setMode(mode: ComposerMode): void {
    this.#mode = mode
  }

  setView(view: ComposerSourceView): void {
    this.#projection = composerProjectionFor(view, this.#mode)
    this.invalidate()
  }

  override render(width: number): string[] {
    const lines = this.#editor.render(width)
    if (lines.length === 0) return []
    const bottomBorder = editorBottomBorder(lines, width)
    const body = boundedEditorBody(lines.slice(1, bottomBorder), this.#rows(), width)
    if (body.length > 0) {
      body[0] = promptBodyLine(body[0], this.#theme, promptActionLabel(this.#projection))
    }
    const autocomplete = lines.slice(bottomBorder + 1)
    if (autocomplete.length === 0) return body
    return [...body, composerBorderLine(width, this.#projection.hint, this.#theme), ...autocomplete]
  }
}

function boundedEditorBody(body: readonly string[], terminalRows: number, width: number): string[] {
  const bodyBudget = Math.max(MIN_USABLE_ROWS, composerRowBudget(terminalRows) - 2)
  const minimumBodyRows = Math.min(MIN_USABLE_ROWS, bodyBudget)
  const visibleBodyRows = Math.min(bodyBudget, Math.max(minimumBodyRows, body.length))
  const bodyWidth = Math.max(1, visibleWidth(body[0] ?? ''), width)

  if (body.length === visibleBodyRows) return [...body]

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
  return paddedBody
}

function editorBottomBorder(lines: readonly string[], width: number): number {
  const index = lines.findIndex((line, lineIndex) => lineIndex > 0 && isEditorBorder(line, width))
  return index < 0 ? lines.length - 1 : index
}

function isEditorBorder(line: string, width: number): boolean {
  const plain = stripTerminalSequences(line)
  if (visibleWidth(plain) !== Math.max(1, width)) return false
  return /^─+$/u.test(plain) || /^─── [↓↑] \d+ more /u.test(plain)
}

export function composerRowBudget(terminalRows: number): number {
  const safeRows = Math.max(1, Math.floor(terminalRows))
  return Math.min(safeRows, Math.max(MIN_USABLE_ROWS + 2, Math.floor(safeRows * COMPOSER_FRACTION)))
}

export function composerBorderLine(width: number, label: string, theme: BraidTheme): string {
  const safeWidth = Math.max(1, Math.floor(width))
  const padded = truncateToWidth(` ${label} `, safeWidth, '…')
  const labelWidth = visibleWidth(padded)
  const remaining = Math.max(0, safeWidth - labelWidth)
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return `${theme.editor.borderColor('─'.repeat(left))}${theme.accent(padded)}${theme.editor.borderColor('─'.repeat(right))}`
}

function promptActionLabel(projection: ComposerProjection): string | undefined {
  if (projection.action === 'send') return undefined
  if (projection.action === 'queue') {
    return projection.queuePosition === undefined ? 'queue' : `queue #${projection.queuePosition}`
  }
  if (projection.action === 'steer') return 'steer'
  return projection.actionLabel
}

function promptBodyLine(line: string | undefined, theme: BraidTheme, action?: string): string {
  if (line === undefined || !line.startsWith(' ')) return line ?? ''
  const prefix = action === undefined ? theme.accent('›') : theme.warning(`› ${action}`)
  return truncateToWidth(
    `${prefix}${action === undefined ? '' : ' '}${line.slice(1)}`,
    visibleWidth(line),
    '',
  )
}
