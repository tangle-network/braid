import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  Spacer,
  Text,
  type TUI,
} from '@earendil-works/pi-tui'
import type { BraidState } from '../../domain/state.js'
import { type AppView, buildAppView, type MessageView } from '../../app/view-model.js'
import type { BraidTheme } from './theme.js'

export interface TerminalRenderOptions {
  readonly tui: TUI
  readonly theme: BraidTheme
  readonly workspace: string
  readonly onSubmit: (text: string) => void
}

export interface TerminalRenderState {
  readonly analysisStatus: string
  readonly quitArmed: boolean
}

/** Owns terminal widgets and rendering; commands and application effects stay in the shell. */
export class BraidTerminalRenderer {
  readonly #tui: TUI
  readonly #theme: BraidTheme
  readonly #transcript = new Container()
  readonly #dock = new Container()
  readonly #editor: Editor
  readonly #status = new Text('', 1, 0)

  constructor(options: TerminalRenderOptions) {
    this.#tui = options.tui
    this.#theme = options.theme
    this.#editor = new Editor(this.#tui, this.#theme.editor, { paddingX: 1 })
    this.#editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [
          { name: 'help', description: 'Keyboard and commands' },
          { name: 'quit', description: 'Close Braid' },
        ],
        options.workspace,
        null,
      ),
    )
    this.#editor.onSubmit = options.onSubmit
    this.#dock.addChild(this.#editor)
    this.#dock.addChild(this.#status)
  }

  get editor(): Editor {
    return this.#editor
  }

  mount(): void {
    this.#tui.addChild(this.#transcript)
    this.#tui.addChild(this.#dock)
  }

  render(state: BraidState, renderState: TerminalRenderState): void {
    const view = buildAppView(state)
    this.#transcript.clear()
    this.#transcript.addChild(this.#header(view))
    if (view.hiddenMessageCount > 0)
      this.#transcript.addChild(
        new Text(this.#theme.muted(`${view.hiddenMessageCount} earlier messages hidden`), 1, 0),
      )
    for (const message of view.messages) this.#transcript.addChild(this.#message(message))
    if (view.messages.length === 0) {
      this.#transcript.addChild(new Spacer(1))
      this.#transcript.addChild(
        new Text(this.#theme.muted('Write a message, or press Ctrl+P for commands.'), 1, 0),
      )
    }
    const effectiveStatus = renderState.quitArmed ? 'aborted' : view.status
    const statusColor =
      effectiveStatus === 'failed'
        ? this.#theme.danger
        : effectiveStatus === 'running' ||
            effectiveStatus === 'blocked' ||
            effectiveStatus === 'aborted'
          ? this.#theme.warning
          : this.#theme.success
    const statusText = renderState.quitArmed
      ? 'press ctrl+c again to quit'
      : renderState.analysisStatus || view.statusText
    this.#status.setText(
      `${statusColor(statusText)}  ${this.#theme.muted('ctrl+p commands · ctrl+c clear/cancel/quit')}`,
    )
    this.#editor.disableSubmit = view.status === 'running'
    this.#editor.borderColor = view.status === 'running' ? this.#theme.warning : this.#theme.accent
    this.#tui.requestRender()
  }

  #header(view: AppView): Text {
    return new Text(
      `${this.#theme.brand('braid')}  ${this.#theme.text(view.profileName)}  ${this.#theme.muted(
        `${view.runner} · ${view.connection}`,
      )}`,
      1,
      1,
    )
  }

  #message(message: MessageView): Container {
    const container = new Container()
    if (message.role === 'user') {
      const box = new Box(1, 0, this.#theme.userBackground)
      box.addChild(new Markdown(message.text, 0, 0, this.#theme.markdown))
      container.addChild(box)
      return container
    }
    container.addChild(new Spacer(1))
    if (message.text) container.addChild(new Markdown(message.text, 1, 0, this.#theme.markdown))
    else if (message.status === 'streaming')
      container.addChild(new Text(this.#theme.muted('Working…'), 1, 0))
    if (message.status === 'failed' || message.status === 'blocked')
      container.addChild(new Text(this.#theme.danger(message.status), 1, 0))
    else if (message.status === 'aborted')
      container.addChild(new Text(this.#theme.warning('cancelled'), 1, 0))
    return container
  }
}
