import { Container, Editor, Text, type TUI, truncateToWidth } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeNotification, sanitizeTerminalText } from '../shared/sanitize.js'
import { ActivityView } from './activity.js'
import { layoutFor } from './layout.js'
import { SurfacePanel } from './surface-panel.js'
import type { BraidTheme } from './theme.js'
import { TranscriptView } from './transcript.js'

export class BraidShell extends Container {
  readonly #transcript: TranscriptView
  readonly #activity: ActivityView
  readonly #editor: Editor
  readonly #status: Text
  readonly #theme: BraidTheme
  readonly #rows: () => number
  #view: BraidViewModel | undefined
  #showActivity = true
  #quitArmed = false

  constructor(
    tui: TUI,
    theme: BraidTheme,
    rows: () => number,
    onSubmit: (text: string) => void,
    onChange: (text: string) => void,
  ) {
    super()
    this.#theme = theme
    this.#rows = rows
    this.#transcript = new TranscriptView(theme)
    this.#activity = new ActivityView(theme)
    this.#editor = new Editor(tui, theme.editor, { paddingX: 1 })
    this.#status = new Text('', 0, 0)
    this.#editor.onSubmit = onSubmit
    this.#editor.onChange = onChange
    this.addChild(this.#transcript)
    this.addChild(this.#activity)
    this.addChild(this.#editor)
    this.addChild(this.#status)
  }

  get editor(): Editor {
    return this.#editor
  }

  setActivityVisible(visible: boolean): void {
    this.#showActivity = visible
    this.invalidate()
  }

  setView(view: BraidViewModel, quitArmed: boolean): void {
    this.#view = view
    this.#quitArmed = quitArmed
    this.#transcript.setView(view)
    this.#activity.setView(view)
    this.#editor.disableSubmit = false
    this.#editor.borderColor =
      view.status === 'running' || view.status === 'waiting'
        ? this.#theme.warning
        : this.#theme.accent
    this.invalidate()
  }

  override render(width: number): string[] {
    const view = this.#view
    if (!view) return super.render(width)
    const layout = layoutFor(width, this.#rows())
    const editorHeight = Math.max(3, Math.min(7, Math.floor(layout.rows * 0.28)))
    const editorLines = this.#editor.render(width).slice(-editorHeight)
    const mode = view.activeRunId
      ? view.status === 'waiting'
        ? 'interaction above'
        : 'queue next turn'
      : 'new message'
    const composer = [
      this.#theme.muted(`> ${mode}`),
      ...editorLines,
      this.#theme.muted(
        width < 80
          ? 'Enter send  ·  Ctrl+P commands'
          : 'Enter send  ·  Shift+Enter newline  ·  Ctrl+P commands',
      ),
    ]
    const notice = view.notice ? [this.#notice(view.notice.tone, view.notice.text, width)] : []
    const status = this.#statusLine(view, width)
    const dock = [...notice, ...composer, status]
    const contentRows = Math.max(1, layout.rows - dock.length)
    const transcriptLines = this.#keepTranscriptHeader(
      this.#transcript.render(layout.transcriptWidth),
      contentRows,
    )
    const activityLines =
      layout.mode === 'wide' && this.#showActivity
        ? this.#tail(this.#activity.render(layout.activityWidth), contentRows)
        : []
    const content: string[] = []
    for (let index = 0; index < contentRows; index += 1) {
      const transcript = transcriptLines[index] ?? ''
      if (activityLines.length === 0) {
        content.push(truncateToWidth(transcript, width, '…', true))
      } else {
        const activity = activityLines[index] ?? ''
        content.push(
          `${truncateToWidth(transcript, layout.transcriptWidth, '…', true)}${' '.repeat(layout.gap)}${truncateToWidth(activity, layout.activityWidth, '…', true)}`,
        )
      }
    }
    return [...content, ...dock].slice(-layout.rows)
  }

  #statusLine(view: BraidViewModel, width: number): string {
    const status = this.#quitArmed
      ? 'press ctrl+c again to quit'
      : sanitizeNotification(view.statusText)
    const colored =
      view.status === 'failed' || view.status === 'storage-failure'
        ? this.#theme.danger(status)
        : view.status === 'running' ||
            view.status === 'waiting' ||
            view.status === 'reconnecting' ||
            this.#quitArmed
          ? this.#theme.warning(status)
          : this.#theme.success(status)
    const run = view.runs.at(-1)
    const usage = run?.usage?.costUsd === undefined ? '' : `  $${run.usage.costUsd.toFixed(2)}`
    const queue = view.queueCount > 0 ? `  queue:${view.queueCount}` : ''
    const hint =
      width < 80
        ? 'Ctrl+C clear/cancel/quit'
        : 'Ctrl+P commands  ·  F2 activity  ·  Ctrl+C clear/cancel/quit'
    return truncateToWidth(
      `${colored}${usage}${queue}  ${this.#theme.muted(hint)}`,
      width,
      '…',
      true,
    )
  }

  #notice(
    tone: NonNullable<BraidViewModel['notice']>['tone'],
    text: string,
    width: number,
  ): string {
    const color =
      tone === 'danger'
        ? this.#theme.danger
        : tone === 'warning'
          ? this.#theme.warning
          : tone === 'success'
            ? this.#theme.success
            : this.#theme.muted
    return truncateToWidth(`${color(tone)}  ${sanitizeNotification(text)}`, width, '…', true)
  }

  #tail(lines: readonly string[], count: number): string[] {
    return lines.slice(Math.max(0, lines.length - count))
  }

  #keepTranscriptHeader(lines: readonly string[], count: number): string[] {
    if (lines.length <= count) return [...lines]
    if (count <= 1) return [lines[0] ?? '']
    return [
      lines[0] ?? '',
      ...(count > 2 ? [lines[1] ?? ''] : []),
      ...this.#tail(lines.slice(2), count - Math.min(2, count)),
    ]
  }
}

export class UnavailablePanel extends SurfacePanel {
  readonly #reason: string

  constructor(theme: BraidTheme, title: string, reason: string) {
    super({ title, theme })
    this.#reason = reason
  }

  protected body(): string[] {
    return [sanitizeTerminalText(this.#reason), 'Capability is not reported by this connection.']
  }
}
