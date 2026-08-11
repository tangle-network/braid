import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { BraidTheme } from './theme.js'

export interface FocusedSurfaceOptions {
  readonly theme: BraidTheme
  readonly title: string
  readonly context?: string
  readonly body: readonly string[]
  readonly footer: string
  readonly width: number
  readonly rows: number
  readonly preserveTailRows?: number
}

/** Frames one focused workflow and covers the terminal behind it. */
export function focusedSurfaceLines(options: FocusedSurfaceOptions): string[] {
  const width = Math.max(1, Math.floor(options.width))
  const rows = Math.max(4, Math.floor(options.rows))
  const bodyRows = rows - 4
  const divider = options.theme.muted('─'.repeat(width))
  const body = fitBody(options.body, bodyRows, width, options.theme, options.preserveTailRows ?? 0)

  return [
    fitLine(header(options, width), width),
    divider,
    ...body,
    ...Array.from({ length: bodyRows - body.length }, () => ''),
    divider,
    fitLine(` ${options.theme.muted(options.footer)}`, width),
  ]
}

function header(options: FocusedSurfaceOptions, width: number): string {
  const title = ` ${options.theme.brand(options.title)}`
  const context = options.context === undefined ? '' : options.theme.muted(options.context)
  const gap = width - visibleWidth(title) - visibleWidth(context) - 1
  return context && gap >= 2 ? `${title}${' '.repeat(gap)}${context} ` : title
}

function fitBody(
  lines: readonly string[],
  rows: number,
  width: number,
  theme: BraidTheme,
  preserveTailRows: number,
): string[] {
  if (rows <= 0) return []
  if (lines.length <= rows) return lines.map((line) => fitLine(line, width))
  if (rows === 1) return [fitLine(` ${theme.muted('… more details')}`, width)]
  const tailRows = Math.max(0, Math.min(Math.floor(preserveTailRows), rows - 2))
  if (tailRows > 0) {
    const headRows = rows - tailRows - 1
    const hiddenRows = lines.length - headRows - tailRows
    return [
      ...lines.slice(0, headRows).map((line) => fitLine(line, width)),
      fitLine(` ${theme.muted(`… ${hiddenRows} hidden lines`)}`, width),
      ...lines.slice(-tailRows).map((line) => fitLine(line, width)),
    ]
  }
  return [
    ...lines.slice(0, rows - 1).map((line) => fitLine(line, width)),
    fitLine(` ${theme.muted(`… ${lines.length - rows + 1} more lines`)}`, width),
  ]
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, width, '…', true)
}
