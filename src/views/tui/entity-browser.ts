import {
  Container,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { entityBrowserFooter } from './entity-browser-layout.js'
import { omitUnreportedCostAndLatency } from './measurement-display.js'
import type { ModalBackTarget } from './modal-coordinator.js'
import type { BraidTheme } from './theme.js'

export interface EntityBrowserRow {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly status: string
  readonly meta?: string
  readonly depth?: number
  readonly current?: boolean
  readonly detailLines: readonly string[]
}

export interface EntityBrowserDocument {
  readonly title: string
  readonly context?: string
  readonly pinned?: string
  readonly notice?: string
  readonly filterHint?: string
  readonly emptyMessage: string
  readonly rows: readonly EntityBrowserRow[]
}

export interface EntityBrowserOptions {
  readonly document: (selectedId?: string) => EntityBrowserDocument
  readonly rows: () => number
  readonly onClose: () => void
  readonly selectedId?: string
  readonly openSelected?: boolean
}

type BrowserMode = 'list' | 'detail'

/** One keyboard model for activity, analyses, workers, and graph entities. */
export class EntityBrowser extends Container implements Focusable, ModalBackTarget {
  readonly #theme: BraidTheme
  readonly #document: (selectedId?: string) => EntityBrowserDocument
  readonly #terminalRows: () => number
  readonly #onClose: () => void
  #selectedId: string | undefined
  #selectedIndex = 0
  #page = 0
  #mode: BrowserMode
  #focused = false
  #lastWidth = 80

  constructor(theme: BraidTheme, options: EntityBrowserOptions) {
    super()
    this.#theme = theme
    this.#document = options.document
    this.#terminalRows = options.rows
    this.#onClose = options.onClose
    this.#selectedId = options.selectedId
    this.#mode = options.openSelected === true ? 'detail' : 'list'
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
  }

  get mode(): BrowserMode {
    return this.#mode
  }

  get selectedId(): string | undefined {
    return this.#selectedId
  }

  selectId(id: string, open = false): void {
    this.#selectedId = id
    this.#mode = open ? 'detail' : 'list'
    this.#page = 0
    this.invalidate()
  }

  goBack(): boolean {
    const document = this.#resolveDocument()
    if (this.#usesWideBrowser(document, this.#lastWidth)) return false
    if (this.#mode === 'list') return false
    this.#mode = 'list'
    this.#page = 0
    this.invalidate()
    return true
  }

  handleInput(data: string): void {
    const document = this.#resolveDocument()
    const split = this.#showsSplitView(document, this.#lastWidth)
    const wide = this.#usesWideBrowser(document, this.#lastWidth)
    const detailVisible = split || (wide && document.rows.length === 1) || this.#mode === 'detail'
    if (matchesKey(data, 'escape') || matchesKey(data, 'left')) {
      if (!this.goBack()) this.#onClose()
      return
    }
    if (document.rows.length === 0) return
    if (matchesKey(data, 'enter') || matchesKey(data, 'return') || matchesKey(data, 'right')) {
      if (!wide && this.#mode === 'list') {
        this.#mode = 'detail'
        this.#page = 0
        this.invalidate()
      }
      return
    }
    if (matchesKey(data, 'up')) {
      this.#moveSelection(document, -1)
      return
    }
    if (matchesKey(data, 'down')) {
      this.#moveSelection(document, 1)
      return
    }
    if (matchesKey(data, 'home')) {
      if (split || !detailVisible) this.#select(document, 0)
      else this.#setPage(0, document)
      return
    }
    if (matchesKey(data, 'end')) {
      if (split || !detailVisible) this.#select(document, document.rows.length - 1)
      else this.#setPage(Number.MAX_SAFE_INTEGER, document)
      return
    }
    if (matchesKey(data, 'pageUp')) this.#setPage(this.#page - 1, document)
    if (matchesKey(data, 'pageDown')) this.#setPage(this.#page + 1, document)
  }

  override render(width: number): string[] {
    const document = this.#resolveDocument()
    const safeWidth = Math.max(1, width)
    this.#lastWidth = safeWidth
    const split = this.#showsSplitView(document, safeWidth)
    const singleDetail = this.#usesWideBrowser(document, safeWidth) && document.rows.length === 1
    const bodyRows = this.#bodyRows()
    const divider = this.#theme.muted('─'.repeat(safeWidth))
    const notice =
      document.notice === undefined
        ? []
        : [this.#line(this.#theme.warning(`! ${document.notice}`), safeWidth)]
    const pinned = this.#pinnedRows(document, safeWidth)
    const contentRows = Math.max(0, bodyRows - notice.length - pinned.length)
    const content =
      contentRows === 0
        ? []
        : split
          ? this.#renderSplit(document, safeWidth, contentRows)
          : singleDetail
            ? this.#renderDetail(document, safeWidth, contentRows)
            : this.#mode === 'detail'
              ? this.#renderDetail(document, safeWidth, contentRows)
              : this.#renderList(document, safeWidth, contentRows)
    const renderedBody = [...notice, ...pinned, ...content]
    const body = [
      ...renderedBody,
      ...Array.from({ length: bodyRows - renderedBody.length }, () => ''),
    ]
    return [
      this.#header(document, safeWidth, split || singleDetail),
      divider,
      ...body,
      divider,
      this.#footer(document, safeWidth),
    ]
  }

  #resolveDocument(): EntityBrowserDocument {
    const previousSelectedId = this.#selectedId
    let document = this.#document(previousSelectedId)
    if (document.rows.length === 0) {
      this.#selectedId = undefined
      this.#selectedIndex = 0
      this.#mode = 'list'
      this.#page = 0
      return document
    }
    const selected =
      this.#selectedId === undefined
        ? -1
        : document.rows.findIndex((row) => row.id === this.#selectedId)
    if (selected < 0 && this.#selectedId !== undefined && this.#mode === 'detail') {
      this.#mode = 'list'
      this.#page = 0
    }
    this.#selectedIndex =
      selected >= 0 ? selected : Math.min(this.#selectedIndex, document.rows.length - 1)
    this.#selectedId = document.rows[this.#selectedIndex]?.id
    if (this.#selectedId !== previousSelectedId) document = this.#document(this.#selectedId)
    return document
  }

  #moveSelection(document: EntityBrowserDocument, delta: -1 | 1): void {
    this.#select(document, this.#selectedIndex + delta)
    this.#page = 0
  }

  #select(document: EntityBrowserDocument, index: number): void {
    const next = Math.max(0, Math.min(index, document.rows.length - 1))
    if (next === this.#selectedIndex) return
    this.#selectedIndex = next
    this.#selectedId = document.rows[next]?.id
    this.invalidate()
  }

  #setPage(page: number, document: EntityBrowserDocument): void {
    if (this.#mode !== 'detail' && !this.#usesWideBrowser(document, this.#lastWidth)) return
    const pages = this.#detailPageCount(document, this.#lastWidth)
    const next = Math.max(0, Math.min(page, pages - 1))
    if (next === this.#page) return
    this.#page = next
    this.invalidate()
  }

  #renderList(document: EntityBrowserDocument, width: number, count: number): string[] {
    if (document.rows.length === 0) {
      return [this.#line(this.#theme.muted(document.emptyMessage), width)]
    }
    const start = listWindowStart(this.#selectedIndex, document.rows.length, count)
    return document.rows.slice(start, start + count).map((row, offset) => {
      const selected = start + offset === this.#selectedIndex
      const prefix = selected ? this.#theme.accent('›') : ' '
      const branch =
        row.depth && row.depth > 0
          ? this.#theme.muted(`${'  '.repeat(Math.min(4, row.depth))}└ `)
          : ''
      const marker = this.#marker(row.status)
      const kind = sanitizeTerminalText(row.kind)
      const rawTitle = sanitizeTerminalText(row.title)
      const title = selected ? this.#theme.accent(rawTitle) : this.#theme.text(rawTitle)
      const status = sanitizeTerminalText(row.status)
      const meta = row.meta === undefined ? '' : ` · ${sanitizeTerminalText(row.meta)}`
      const current = row.current === true ? ' · current' : ''
      const compact = width < 56
      const suffix = compact
        ? `${this.#theme.muted(` · ${kind}${current}${meta}`)}`
        : `${this.#theme.muted(` · ${kind} · ${status}${current}${meta}`)}`
      return this.#line(`${prefix} ${branch}${marker} ${title}${suffix}`, width)
    })
  }

  #renderDetail(document: EntityBrowserDocument, width: number, count: number): string[] {
    const selected = document.rows[this.#selectedIndex]
    if (selected === undefined) return [this.#line(this.#theme.muted(document.emptyMessage), width)]
    const visualLines = this.#detailVisualLines(selected, width)
    const pages = pageCount(visualLines.length, count)
    this.#page = Math.max(0, Math.min(this.#page, pages - 1))
    const start = this.#page * count
    const lines = visualLines.slice(start, start + count)
    if (lines.length === 0) lines.push('No additional details were reported.')
    return lines.map((value) => this.#line(value, width))
  }

  #renderSplit(document: EntityBrowserDocument, width: number, count: number): string[] {
    const listWidth = splitListWidth(width)
    const detailWidth = splitDetailWidth(width)
    const list = this.#renderList(document, listWidth, count)
    const detail = this.#renderDetail(document, detailWidth, count)
    const divider = this.#theme.muted('│')
    return Array.from({ length: count }, (_, index) => {
      const left = fitColumn(list[index] ?? '', listWidth)
      const right = truncateToWidth(detail[index] ?? '', detailWidth, '…', true)
      return `${left}${divider}${right}`
    })
  }

  #header(document: EntityBrowserDocument, width: number, detailVisible: boolean): string {
    const selected = document.rows[this.#selectedIndex]
    const title = sanitizeTerminalText(document.title)
    const primary =
      (!detailVisible && this.#mode === 'list') || selected === undefined
        ? this.#theme.brand(`${title} · ${document.rows.length}`)
        : `${this.#theme.brand(title)} ${this.#theme.muted('›')} ${this.#theme.accent(sanitizeTerminalText(selected.title))}`
    const context =
      document.context === undefined ? undefined : sanitizeTerminalText(document.context)
    return this.#line(this.#withContext(primary, context, width), width)
  }

  #footer(document: EntityBrowserDocument, width: number): string {
    const pages = this.#detailPageCount(document, width)
    const mode = this.#usesWideBrowser(document, width)
      ? 'wide'
      : this.#mode === 'list'
        ? 'list'
        : 'detail'
    return this.#line(
      this.#theme.muted(
        entityBrowserFooter({
          mode,
          width,
          rowCount: document.rows.length,
          bodyRows: this.#bodyRows(),
          selectedIndex: this.#selectedIndex,
          pages,
          page: this.#page,
          ...(document.filterHint === undefined
            ? {}
            : { filterHint: sanitizeTerminalText(document.filterHint) }),
        }),
      ),
      width,
    )
  }

  #bodyRows(): number {
    return Math.max(1, this.#terminalRows() - 4)
  }

  #detailPageCount(document: EntityBrowserDocument, width: number): number {
    const selected = document.rows[this.#selectedIndex]
    const detailWidth = this.#showsSplitView(document, width) ? splitDetailWidth(width) : width
    const lines = selected === undefined ? 0 : this.#detailVisualLines(selected, detailWidth).length
    const noticeRows = document.notice === undefined ? 0 : 1
    const pinnedRows = this.#pinnedRows(document, width).length
    return pageCount(lines, Math.max(1, this.#bodyRows() - noticeRows - pinnedRows))
  }

  #pinnedRows(document: EntityBrowserDocument, width: number): string[] {
    if (document.pinned === undefined) return []
    return wrapTextWithAnsi(
      this.#theme.muted(sanitizeTerminalText(document.pinned)),
      Math.max(1, width - 1),
    )
      .slice(0, 2)
      .map((line) => this.#line(line, width))
  }

  #detailVisualLines(selected: EntityBrowserRow, width: number): string[] {
    const lineWidth = Math.max(1, width - 1)
    return omitUnreportedCostAndLatency(selected.detailLines).flatMap((value) => {
      const safe = sanitizeTerminalText(value)
      const styled = safe.startsWith('── ')
        ? this.#theme.accent(safe)
        : safe.startsWith('! ')
          ? this.#theme.warning(safe)
          : safe.startsWith('↳ ')
            ? this.#theme.muted(safe)
            : safe
      return wrapTextWithAnsi(styled, lineWidth)
    })
  }

  #line(value: string, width: number): string {
    return truncateToWidth(` ${value}`, Math.max(1, width), '…', true)
  }

  #marker(status: string): string {
    const marker = statusMarker(status)
    if (status === 'completed' || status === 'complete') return this.#theme.success(marker)
    if (status === 'failed' || status === 'storage-failure') return this.#theme.danger(marker)
    if (status === 'running' || status === 'streaming' || status === 'starting') {
      return this.#theme.warning(marker)
    }
    return this.#theme.muted(marker)
  }

  #withContext(primary: string, context: string | undefined, width: number): string {
    if (context === undefined) return primary
    const available = Math.max(1, width - 2)
    const parts = context.split(' · ').filter((part) => part.length > 0)
    for (let count = parts.length; count > 0; count -= 1) {
      const candidate = this.#theme.muted(parts.slice(0, count).join(' · '))
      const gap = available - visibleWidth(primary) - visibleWidth(candidate)
      if (gap >= 3) return `${primary}${' '.repeat(gap)}${candidate}`
    }
    return primary
  }

  #usesSplitView(width: number): boolean {
    return width >= 100 && this.#terminalRows() >= 16
  }

  #usesWideBrowser(document: EntityBrowserDocument, width: number): boolean {
    return this.#usesSplitView(width) && document.rows.length > 0
  }

  #showsSplitView(document: EntityBrowserDocument, width: number): boolean {
    return this.#usesSplitView(width) && document.rows.length > 1
  }
}

function statusMarker(status: string): string {
  switch (status) {
    case 'completed':
    case 'complete':
      return '✓'
    case 'failed':
    case 'storage-failure':
      return '×'
    case 'running':
    case 'streaming':
    case 'starting':
      return '●'
    case 'waiting':
      return '?'
    case 'cancelled':
    case 'cancelling':
      return '■'
    default:
      return '·'
  }
}

function listWindowStart(selected: number, total: number, count: number): number {
  if (total <= count) return 0
  return Math.max(0, Math.min(selected - Math.floor(count / 2), total - count))
}

function pageCount(lines: number, pageRows: number): number {
  return Math.max(1, Math.ceil(lines / Math.max(1, pageRows)))
}

function fitColumn(value: string, width: number): string {
  const fitted = truncateToWidth(value, width, '…', true)
  return `${fitted}${' '.repeat(Math.max(0, width - visibleWidth(fitted)))}`
}

function splitListWidth(width: number): number {
  return Math.max(30, Math.min(52, Math.floor(width * 0.34)))
}

function splitDetailWidth(width: number): number {
  return Math.max(1, width - splitListWidth(width) - 1)
}
