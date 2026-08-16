import {
  Container,
  Editor,
  matchesKey,
  Text,
  type TUI,
  truncateToWidth,
} from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { type ComposerMode, ComposerView } from './composer-view.js'
import { layoutFor } from './layout.js'
import { TerminalChrome } from './terminal-chrome.js'
import type { BraidTheme } from './theme.js'
import { TranscriptView } from './transcript.js'

export class BraidShell extends Container {
  readonly #transcript: TranscriptView
  readonly #chrome: TerminalChrome
  readonly #composer: ComposerView
  readonly #theme: BraidTheme
  readonly #rows: () => number
  #view: BraidViewModel | undefined
  #modalVisible = false
  #quitArmed = false
  #composerMode: ComposerMode = 'queue'

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
    this.#chrome = new TerminalChrome(theme)
    const editor = new Editor(tui, theme.editor, { paddingX: 1 })
    editor.onSubmit = onSubmit
    editor.onChange = onChange
    this.#composer = new ComposerView({ editor, rows, theme })
    this.addChild(this.#transcript)
    this.addChild(this.#composer)
  }

  get editor(): Editor {
    return this.#composer.editor
  }

  setComposerMode(mode: ComposerMode): void {
    this.#composerMode = mode
    this.#composer.setMode(mode)
    if (this.#view) this.#composer.setView(this.#view)
    this.#refreshChrome()
  }

  setModalVisible(visible: boolean): void {
    this.#modalVisible = visible
    this.invalidate()
  }

  setView(view: BraidViewModel, quitArmed: boolean): void {
    this.#view = view
    this.#quitArmed = quitArmed
    this.#transcript.setView(view)
    this.#composer.setView(view)
    this.#chrome.setState({
      view,
      quitArmed,
      activityVisible: false,
      navigationHint: this.#transcript.navigationHint(),
      composerMode: this.#composerMode,
    })
    this.#composer.editor.disableSubmit = false
    this.#composer.editor.borderColor =
      view.status === 'running' ? this.#theme.warning : this.#theme.accent
    this.invalidate()
  }

  handleTranscriptInput(data: string): boolean {
    const explicitTranscriptKey =
      matchesKey(data, 'alt+home') ||
      matchesKey(data, 'alt+end') ||
      matchesKey(data, 'pageUp') ||
      matchesKey(data, 'pageDown') ||
      matchesKey(data, 'alt+pageUp') ||
      matchesKey(data, 'alt+pageDown')
    if (!explicitTranscriptKey && this.#composer.editor.getText().length > 0) return false
    const handled = this.#transcript.handleInput(data)
    if (handled) this.#refreshChrome()
    return handled
  }

  toggleDetails(): boolean {
    const toggled = this.#transcript.toggleDetails()
    if (toggled) this.#refreshChrome()
    return toggled
  }

  navigationHint(): string {
    return this.#transcript.navigationHint()
  }

  hasCollapsibleDetails(): boolean {
    return this.#transcript.hasCollapsibleDetails()
  }

  override render(width: number): string[] {
    const view = this.#view
    if (!view) return super.render(width)
    const layout = layoutFor(width, this.#rows(), false)
    const editorLines = this.#modalVisible ? [] : this.#composer.render(width)
    const topChrome = this.#chrome.renderTop(width)
    const bottomChrome = this.#modalVisible ? [] : this.#chrome.renderBottom(width)
    const dockRows = topChrome.length + bottomChrome.length + editorLines.length
    const contentRows = Math.max(1, layout.rows - dockRows)
    this.#transcript.setViewportRows(contentRows)
    const transcriptLines = this.#modalVisible
      ? []
      : this.#transcript.render(layout.transcriptWidth)
    this.#refreshChrome()
    const content = Array.from({ length: contentRows }, (_, index) =>
      truncateToWidth(transcriptLines[index] ?? '', width, '…', true),
    )
    return [...topChrome, ...content, ...editorLines, ...this.#chrome.renderBottom(width)].slice(
      0,
      layout.rows,
    )
  }

  #refreshChrome(): void {
    const view = this.#view
    if (!view) return
    this.#chrome.setState({
      view,
      quitArmed: this.#quitArmed,
      activityVisible: false,
      navigationHint: this.#transcript.navigationHint(),
      composerMode: this.#composerMode,
    })
    this.invalidate()
  }
}

export class UnavailablePanel extends Container {
  constructor(theme: BraidTheme, title: string, reason: string) {
    super()
    this.addChild(new Text(theme.warning(sanitizeTerminalText(title)), 1, 0))
    this.addChild(new Text(sanitizeTerminalText(reason), 1, 0))
    this.addChild(
      new Text(theme.muted('This action is unavailable with the selected connection.'), 1, 0),
    )
    this.addChild(new Text(theme.muted('←/esc close'), 1, 0))
  }
}
