import { Box, type Component, Container, matchesKey, Spacer, Text } from '@earendil-works/pi-tui'
import type { BraidViewModel, MessageView, TranscriptPartView } from '../shared/models.js'
import { sanitizeDiff, sanitizeMarkdown, sanitizeTerminalText } from '../shared/sanitize.js'
import { SafeMarkdown } from './safe-markdown.js'
import type { BraidTheme } from './theme.js'

const COLLAPSIBLE_KINDS = new Set<TranscriptPartView['kind']>([
  'reasoning',
  'tool',
  'result',
  'artifact',
  'analysis',
])
export const STREAMING_TAIL_BYTES = 32 * 1024
const STREAMING_TAIL_PREFIX = '…\n'
const STREAMING_TAIL_CONTENT_BYTES =
  STREAMING_TAIL_BYTES - Buffer.byteLength(STREAMING_TAIL_PREFIX, 'utf8')
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export class TranscriptView extends Container {
  readonly #theme: BraidTheme
  #view: BraidViewModel | undefined
  #viewportRows = Number.MAX_SAFE_INTEGER
  #scrollTop = 0
  #followTail = true
  #pendingHistoryPosition: 'start' | { readonly tailOffsetRows: number } | undefined
  #lastLines: readonly string[] = []
  readonly #expandedParts = new Set<string>()
  #detailCursorId: string | undefined

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.#view = view
    this.clear()
    if (view.hiddenMessageCount > 0) {
      this.addChild(
        new Text(this.#theme.muted(`${view.hiddenMessageCount} earlier messages hidden`), 1, 0),
      )
    }
    for (const entry of view.queue ?? []) this.addChild(this.#queue(entry))
    for (const message of view.messages) this.addChild(this.#message(message))
    if (view.messages.length === 0) {
      this.addChild(new Spacer(1))
      this.addChild(
        new Text(this.#theme.muted('Write a message, or press Ctrl+P for commands.'), 1, 0),
      )
    }
    const present = new Set(
      view.messages.flatMap((message) =>
        message.parts.filter((part) => COLLAPSIBLE_KINDS.has(part.kind)).map((part) => part.id),
      ),
    )
    for (const id of this.#expandedParts) if (!present.has(id)) this.#expandedParts.delete(id)
    if (this.#detailCursorId !== undefined && !present.has(this.#detailCursorId))
      this.#detailCursorId = undefined
    this.invalidate()
  }

  setViewportRows(rows: number): void {
    this.#viewportRows = Math.max(1, Math.floor(rows))
    this.invalidate()
  }

  get followTail(): boolean {
    return this.#followTail
  }

  get canScroll(): boolean {
    return this.#maxScroll() > 0
  }

  navigationHint(): string {
    if (this.canScroll && !this.#followTail) return 'PgUp/PgDn history · End follow'
    const detailCount = this.#detailParts().length
    if (detailCount > 1) {
      const current = this.#detailCursorId
        ? this.#detailParts().findIndex((part) => part.id === this.#detailCursorId) + 1
        : detailCount
      return `Ctrl+E next detail (${current}/${detailCount})`
    }
    if (detailCount === 1) return 'Ctrl+E detail'
    if (this.canScroll) return 'PgUp/PgDn history'
    return 'Ctrl+P commands'
  }

  hasCollapsibleDetails(): boolean {
    return this.#detailParts().length > 0
  }

  toggleDetails(): boolean {
    const view = this.#view
    if (view === undefined) return false
    const parts = this.#detailParts()
    if (parts.length === 0) return false
    const currentIndex = this.#detailCursorId
      ? parts.findIndex((part) => part.id === this.#detailCursorId)
      : -1
    const nextIndex = currentIndex < 0 ? parts.length - 1 : (currentIndex + 1) % parts.length
    const next = parts[nextIndex]
    if (next === undefined) return false
    this.#detailCursorId = next.id
    for (const id of this.#expandedParts) this.#expandedParts.delete(id)
    this.#expandedParts.add(next.id)
    this.setView(view)
    return true
  }

  /** Returns true when this key changed the transcript position. */
  handleInput(data: string): boolean {
    const page = Math.max(1, this.#viewportRows - 2)
    if (matchesKey(data, 'pageUp') || matchesKey(data, 'alt+pageUp')) {
      if (this.#followTail) {
        this.#openHistory({ tailOffsetRows: page })
        return true
      }
      this.#moveTo(this.#scrollTop - page)
      return true
    }
    if (matchesKey(data, 'pageDown') || matchesKey(data, 'alt+pageDown')) {
      this.#moveTo(this.#scrollTop + page)
      return true
    }
    if (matchesKey(data, 'home') || matchesKey(data, 'alt+home')) {
      if (this.#followTail) {
        this.#openHistory('start')
        return true
      }
      this.#moveTo(0)
      return true
    }
    if (matchesKey(data, 'end') || matchesKey(data, 'alt+end')) {
      this.#moveTo(this.#maxScroll())
      return true
    }
    return false
  }

  override render(width: number): string[] {
    const allLines = super.render(Math.max(1, Math.floor(width)))
    this.#lastLines = allLines
    const max = Math.max(0, allLines.length - this.#viewportRows)
    if (this.#pendingHistoryPosition === 'start') {
      this.#scrollTop = 0
      this.#pendingHistoryPosition = undefined
    } else if (this.#pendingHistoryPosition !== undefined) {
      this.#scrollTop = Math.max(0, max - this.#pendingHistoryPosition.tailOffsetRows)
      this.#pendingHistoryPosition = undefined
    } else if (this.#followTail) this.#scrollTop = max
    else this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, max))
    return allLines.slice(this.#scrollTop, this.#scrollTop + this.#viewportRows)
  }

  #moveTo(requested: number): void {
    const max = this.#maxScroll()
    this.#scrollTop = Math.max(0, Math.min(Math.trunc(requested), max))
    const followTail = this.#scrollTop >= max
    if (followTail && !this.#followTail) {
      this.#followTail = true
      if (this.#view !== undefined) this.setView(this.#view)
    } else {
      this.#followTail = followTail
    }
    this.invalidate()
  }

  #openHistory(position: 'start' | { readonly tailOffsetRows: number }): void {
    this.#followTail = false
    this.#pendingHistoryPosition = position
    if (this.#view !== undefined) this.setView(this.#view)
  }

  #maxScroll(): number {
    return Math.max(0, this.#lastLines.length - this.#viewportRows)
  }

  #queue(entry: NonNullable<BraidViewModel['queue']>[number]): Text {
    const status =
      entry.status === 'blocked' ? this.#theme.danger('blocked') : this.#theme.warning('queued')
    return new Text(`${status} ${entry.position}. ${sanitizeTerminalText(entry.text)}`, 1, 0)
  }

  #message(message: MessageView): Container {
    const container = new Container()
    if (this.#theme.highContrast)
      container.addChild(new Text(this.#theme.accent(`${message.role}:`), 1, 0))
    if (message.role === 'user') {
      const box = new Box(1, 0, this.#theme.userBackground)
      box.addChild(
        new SafeMarkdown(
          sanitizeMarkdown(message.text),
          0,
          0,
          this.#theme.markdown,
          undefined,
          undefined,
          { allowHyperlinks: this.#theme.terminalMetadata },
        ),
      )
      container.addChild(box)
      return container
    }

    container.addChild(new Spacer(1))
    const streamingTail = message.status === 'streaming' && this.#followTail
    for (const part of message.parts) container.addChild(this.#part(part, streamingTail))
    if (message.parts.length === 0 && message.text) {
      container.addChild(this.#markdown(streamingTailText(message.text, streamingTail)))
    }
    if (message.status === 'failed' || message.status === 'blocked') {
      container.addChild(new Text(this.#theme.danger(message.status), 1, 0))
    } else if (message.status === 'cancelled' || message.status === 'aborted') {
      container.addChild(new Text(this.#theme.warning('cancelled'), 1, 0))
    } else if (message.status === 'redacted') {
      container.addChild(new Text(this.#theme.muted('content removed'), 1, 0))
    } else if (message.status === 'streaming') {
      container.addChild(new Text(this.#theme.warning(this.#theme.progress('working')), 1, 0))
    }
    return container
  }

  #part(part: TranscriptPartView, streamingTail: boolean): Component {
    const text = part.kind === 'text' ? streamingTailText(part.text, streamingTail) : part.text
    if (
      part.kind === 'text' &&
      part.input === undefined &&
      part.result === undefined &&
      part.error === undefined
    )
      return this.#markdown(text)
    if (COLLAPSIBLE_KINDS.has(part.kind)) return this.#card(part)
    const safeText = part.kind === 'artifact' ? sanitizeDiff(text) : sanitizeMarkdown(text)
    return this.#plainPart(part, safeText)
  }

  #plainPart(part: TranscriptPartView, text: string): Container {
    const container = new Container()
    const label = part.kind === 'text' ? '' : `${part.kind} · `
    if (label.length > 0 || part.status !== undefined)
      container.addChild(new Text(this.#theme.muted(`${label}${part.status ?? 'unknown'}`), 1, 0))
    if (text) container.addChild(this.#markdown(text))
    if (part.error)
      container.addChild(new Text(this.#theme.danger(sanitizeTerminalText(part.error)), 1, 0))
    return container
  }

  #card(part: TranscriptPartView): Container {
    const container = new Container()
    const status = part.status ?? 'unknown'
    const label =
      part.kind === 'reasoning' ? 'thought' : (part.toolName ?? part.subject?.title ?? part.kind)
    const color =
      status === 'failed'
        ? this.#theme.danger
        : status === 'running' || status === 'queued'
          ? this.#theme.warning
          : status === 'complete'
            ? this.#theme.success
            : this.#theme.muted
    const symbol =
      status === 'failed' ? 'x' : status === 'complete' ? 'ok' : status === 'running' ? '>' : '·'
    const expanded = part.collapsed === false || this.#expandedParts.has(part.id)
    const detail = detailText(part)
    const detailParts = this.#detailParts()
    const detailIndex = detailParts.findIndex((candidate) => candidate.id === part.id)
    const focus = this.#detailCursorId === part.id ? this.#theme.accent('◆ ') : ''
    const position =
      detailParts.length > 1 && detailIndex >= 0 ? ` ${detailIndex + 1}/${detailParts.length}` : ''
    container.addChild(
      new Text(
        `${focus}${color(`${symbol} ${sanitizeTerminalText(label)} · ${status}`)}${position}${
          detail ? this.#theme.muted(expanded ? ' · open' : ' · collapsed · ctrl+e next') : ''
        }`,
        1,
        0,
      ),
    )
    if (expanded && detail) {
      if (part.kind === 'reasoning') {
        container.addChild(
          new SafeMarkdown(
            sanitizeMarkdown(detail),
            2,
            0,
            this.#theme.markdown,
            { color: this.#theme.muted, italic: true },
            undefined,
            { allowHyperlinks: this.#theme.terminalMetadata },
          ),
        )
      } else {
        container.addChild(this.#markdown(detail, 2))
      }
    }
    if (part.error)
      container.addChild(new Text(this.#theme.danger(sanitizeTerminalText(part.error)), 2, 0))
    return container
  }

  #markdown(text: string, paddingX = 1): SafeMarkdown {
    return new SafeMarkdown(
      sanitizeMarkdown(text),
      paddingX,
      0,
      this.#theme.markdown,
      undefined,
      undefined,
      { allowHyperlinks: this.#theme.terminalMetadata },
    )
  }

  #detailParts(): TranscriptPartView[] {
    return (
      this.#view?.messages
        .flatMap((message) => message.parts)
        .filter((part) => COLLAPSIBLE_KINDS.has(part.kind) && hasPartDetail(part)) ?? []
    )
  }
}

export function streamingTailText(text: string, streamingTail: boolean): string {
  if (!streamingTail) return text
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (totalBytes <= STREAMING_TAIL_BYTES) return text
  let consumedBytes = 0
  for (const entry of GRAPHEME_SEGMENTER.segment(text)) {
    if (totalBytes - consumedBytes <= STREAMING_TAIL_CONTENT_BYTES)
      return `${STREAMING_TAIL_PREFIX}${text.slice(entry.index)}`
    consumedBytes += Buffer.byteLength(entry.segment, 'utf8')
  }
  return STREAMING_TAIL_PREFIX
}

function hasPartDetail(part: TranscriptPartView): boolean {
  return detailText(part).length > 0 || part.error !== undefined
}

function detailText(part: TranscriptPartView): string {
  if (
    part.kind === 'reasoning' ||
    part.kind === 'text' ||
    part.kind === 'warning' ||
    part.kind === 'error'
  )
    return part.text
  if (part.text) return part.text
  if (part.input !== undefined) return `input: ${formatValue(part.input)}`
  if (part.result !== undefined) return `result: ${formatValue(part.result)}`
  return ''
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return sanitizeTerminalText(value)
  try {
    return sanitizeTerminalText(JSON.stringify(value, null, 2) ?? String(value))
  } catch {
    return '[structured value unavailable]'
  }
}
