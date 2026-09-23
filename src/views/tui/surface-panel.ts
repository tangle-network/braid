import { matchesKey, truncateToWidth, type Component, type Focusable } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export interface SurfacePanelOptions {
  readonly title: string
  readonly theme: BraidTheme
  readonly onClose?: () => void
  readonly onConfirm?: () => void
  readonly footer?: string
}

export function wrappedLines(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  return text.split('\n').flatMap((line) => {
    if (!line) return ['']
    const words = line.split(/\s+/u)
    const lines: string[] = []
    let current = ''
    for (const word of words) {
      const next = current ? `${current} ${word}` : word
      if (next.length <= safeWidth) current = next
      else if (current) {
        lines.push(current)
        current = word
      } else {
        lines.push(word.slice(0, safeWidth))
        current = word.slice(safeWidth)
      }
    }
    if (current || lines.length === 0) lines.push(current)
    return lines
  })
}

export function framePanel(
  width: number,
  title: string,
  body: readonly string[],
  theme: BraidTheme,
  footer = 'esc close',
  focused = false,
): string[] {
  const safeWidth = Math.max(8, width)
  const innerWidth = Math.max(1, safeWidth - 4)
  const titleText = `${focused ? '> ' : ''}${sanitizeTerminalText(title)}`
  const top = theme.muted(
    `+-- ${truncateToWidth(titleText, Math.max(1, innerWidth - 3), '…')} ${'-'.repeat(Math.max(0, safeWidth - 7 - Math.min(innerWidth - 3, titleText.length)))}+`,
  )
  const content = body.length > 0 ? body : ['']
  const lines = [top]
  for (const line of content) {
    lines.push(
      `${theme.muted('|')} ${truncateToWidth(line, innerWidth, '…', true)} ${theme.muted('|')}`,
    )
  }
  lines.push(
    `${theme.muted('|')} ${theme.muted(truncateToWidth(footer, innerWidth, '…', true))} ${theme.muted('|')}`,
  )
  lines.push(theme.muted(`+${'-'.repeat(Math.max(0, safeWidth - 2))}+`))
  return lines
}

export abstract class SurfacePanel implements Component, Focusable {
  readonly #theme: BraidTheme
  readonly #title: string
  readonly #onClose: () => void
  readonly #onConfirm: (() => void) | undefined
  readonly #defaultFooter: string
  #focused = false

  constructor(options: SurfacePanelOptions) {
    this.#theme = options.theme
    this.#title = options.title
    this.#onClose = options.onClose ?? (() => {})
    this.#onConfirm = options.onConfirm
    this.#defaultFooter = options.footer ?? 'esc close'
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.#onClose()
      return
    }
    if (matchesKey(data, 'enter') && this.#onConfirm) this.#onConfirm()
  }

  render(width: number): string[] {
    return framePanel(
      width,
      this.#title,
      this.body(Math.max(1, width - 4)),
      this.#theme,
      this.footer() || this.#defaultFooter,
      this.#focused,
    )
  }

  protected abstract body(width: number): string[]

  protected footer(): string {
    return this.#defaultFooter
  }
}

export function safeText(value: string): string {
  return sanitizeTerminalText(value)
}

export function tone(theme: BraidTheme, status: string): string {
  if (status === 'failed' || status === 'danger') return theme.danger(status)
  if (status === 'running' || status === 'waiting' || status === 'reconnecting')
    return theme.warning(status)
  if (status === 'complete' || status === 'completed' || status === 'healthy')
    return theme.success(status)
  return theme.muted(status)
}
