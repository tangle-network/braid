import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  matchesKey,
  Spacer,
  Text,
  type TUI,
} from '@earendil-works/pi-tui'
import type { BraidApplication } from '../../app/application.js'
import { buildAppView, type AppView, type MessageView } from '../../app/view-model.js'
import type { BraidState } from '../../domain/state.js'
import { CommandPalette, type PaletteCommand } from './command-palette.js'
import type { BraidTheme } from './theme.js'
import {
  keyboardAnswerForView,
  responseForInteractionIntent,
} from '../shared/interaction-intent.js'
import type { InteractionViewModel } from '../shared/interaction.js'

export interface BraidTerminalOptions {
  readonly app: BraidApplication
  readonly tui: TUI
  readonly theme: BraidTheme
  readonly workspace: string
  readonly nextOperationId: () => string
}

export class BraidTerminalApp {
  readonly #app: BraidApplication
  readonly #tui: TUI
  readonly #theme: BraidTheme
  readonly #transcript = new Container()
  readonly #dock = new Container()
  readonly #editor: Editor
  readonly #status = new Text('', 1, 0)
  readonly #nextOperationId: () => string
  readonly #done: Promise<void>
  readonly #resolveDone: () => void
  readonly #unsubscribe: () => void
  readonly #removeInputListener: () => void
  #overlayClose: (() => void) | undefined
  #quitTimer: ReturnType<typeof setTimeout> | undefined
  #quitArmed = false
  #stopped = false

  constructor(options: BraidTerminalOptions) {
    this.#app = options.app
    this.#tui = options.tui
    this.#theme = options.theme
    this.#nextOperationId = options.nextOperationId
    let resolveDone: () => void = () => {}
    this.#done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    this.#resolveDone = resolveDone

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
    this.#editor.onSubmit = (text) => this.#submit(text)

    this.#dock.addChild(this.#editor)
    this.#dock.addChild(this.#status)
    this.#mountLayout()
    this.#unsubscribe = this.#app.subscribe((state) => this.#render(state))
    this.#removeInputListener = this.#tui.addInputListener((data) => this.#handleGlobalInput(data))
    this.#render(this.#app.state())
  }

  get editor(): Editor {
    return this.#editor
  }

  start(): Promise<void> {
    this.#tui.setFocus(this.#editor)
    this.#tui.start()
    return this.#done
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#quitTimer) clearTimeout(this.#quitTimer)
    this.#removeInputListener()
    this.#unsubscribe()
    this.#tui.stop()
    this.#resolveDone()
  }

  #mountLayout(): void {
    this.#tui.addChild(this.#transcript)
    this.#tui.addChild(this.#dock)
  }

  #render(state: BraidState): void {
    const view = buildAppView(state, this.#app.interactionCapabilities())
    this.#transcript.clear()
    this.#transcript.addChild(this.#header(view))
    if (view.hiddenMessageCount > 0) {
      this.#transcript.addChild(
        new Text(this.#theme.muted(`${view.hiddenMessageCount} earlier messages hidden`), 1, 0),
      )
    }
    for (const message of view.messages) this.#transcript.addChild(this.#message(message))
    const interaction = view.interactions[0]
    if (interaction) this.#transcript.addChild(this.#interaction(interaction))
    if (view.messages.length === 0) {
      this.#transcript.addChild(new Spacer(1))
      this.#transcript.addChild(
        new Text(this.#theme.muted('Write a message, or press Ctrl+P for commands.'), 1, 0),
      )
    }

    const effectiveStatus = this.#quitArmed ? 'aborted' : view.status
    const statusColor =
      effectiveStatus === 'failed'
        ? this.#theme.danger
        : effectiveStatus === 'running' ||
            effectiveStatus === 'waiting' ||
            effectiveStatus === 'blocked' ||
            effectiveStatus === 'aborted'
          ? this.#theme.warning
          : this.#theme.success
    const statusText = this.#quitArmed ? 'press ctrl+c again to quit' : view.statusText
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
    if (message.text) {
      container.addChild(new Markdown(message.text, 1, 0, this.#theme.markdown))
    } else if (message.status === 'streaming') {
      container.addChild(new Text(this.#theme.muted('Working…'), 1, 0))
    }
    if (message.status === 'failed' || message.status === 'blocked') {
      container.addChild(new Text(this.#theme.danger(message.status), 1, 0))
    } else if (message.status === 'aborted') {
      container.addChild(new Text(this.#theme.warning('cancelled'), 1, 0))
    }
    return container
  }

  #interaction(view: InteractionViewModel): Container {
    const container = new Container()
    const scope = view.allowedScopes.length > 0 ? ` · scopes: ${view.allowedScopes.join(', ')}` : ''
    container.addChild(
      new Text(this.#theme.warning(`[${view.surface}] ${view.title}${scope}`), 1, 0),
    )
    if (view.body) container.addChild(new Markdown(view.body, 1, 0, this.#theme.markdown))
    if (view.subject?.target) {
      container.addChild(
        new Text(this.#theme.muted(`${view.subject.title}: ${view.subject.target}`), 1, 0),
      )
    }
    container.addChild(
      new Text(
        view.canRespond
          ? this.#theme.muted('Enter an answer in the composer · Ctrl+C clears · Esc cancels')
          : this.#theme.danger(
              view.answerSpec.error ?? view.capabilityError ?? 'Only cancellation is available',
            ),
        1,
        0,
      ),
    )
    return container
  }

  #submit(rawText: string): void {
    const text = rawText.trim()
    if (!text) return
    const interaction = this.#app.interactionController()?.views()[0]
    if (interaction) {
      this.#submitInteraction(interaction, rawText)
      return
    }
    if (text === '/quit') {
      this.stop()
      return
    }
    if (text === '/help') {
      this.#openPalette()
      return
    }

    this.#editor.addToHistory(rawText)
    this.#editor.setText('')
    try {
      const receipt = this.#app.send({ operationId: this.#nextOperationId(), text: rawText })
      void receipt.completion.finally(() => {
        this.#editor.disableSubmit = false
        this.#tui.requestRender()
      })
    } catch {
      this.#editor.setText(rawText)
      this.#tui.requestRender()
    }
  }

  #submitInteraction(view: InteractionViewModel, rawText: string): void {
    if (!view.canRespond) return
    const intent = keyboardAnswerForView(view, rawText)
    const response = responseForInteractionIntent(view.interactionId, intent)
    const operationId = this.#nextOperationId()
    this.#editor.setText('')
    void this.#app
      .respondInteraction({
        runId: view.runId,
        interactionId: view.interactionId,
        ...(view.providerSessionId === undefined
          ? {}
          : { providerSessionId: view.providerSessionId }),
        ...(view.profileDigest === undefined ? {} : { profileDigest: view.profileDigest }),
        ...(view.connectionId === undefined ? {} : { connectionId: view.connectionId }),
        ...(view.workspaceId === undefined ? {} : { workspaceId: view.workspaceId }),
        ...(view.runner === undefined ? {} : { runner: view.runner }),
        operationId,
        response,
      })
      .then((result) => {
        if (
          result.status === 'invalid' ||
          result.status === 'stale' ||
          result.status === 'conflict'
        ) {
          this.#editor.setText(rawText)
        }
        this.#tui.requestRender()
      })
      .catch(() => {
        this.#editor.setText(rawText)
        this.#tui.requestRender()
      })
  }

  #handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (!matchesKey(data, 'ctrl+c')) this.#disarmQuit()
    if (matchesKey(data, 'ctrl+p')) {
      this.#openPalette()
      return { consume: true }
    }
    if (matchesKey(data, 'escape')) {
      const interaction = this.#app.interactionController()?.views()[0]
      if (interaction) {
        void this.#app.cancelInteraction({
          runId: interaction.runId,
          interactionId: interaction.interactionId,
          ...(interaction.providerSessionId === undefined
            ? {}
            : { providerSessionId: interaction.providerSessionId }),
          ...(interaction.profileDigest === undefined
            ? {}
            : { profileDigest: interaction.profileDigest }),
          ...(interaction.connectionId === undefined
            ? {}
            : { connectionId: interaction.connectionId }),
          ...(interaction.workspaceId === undefined
            ? {}
            : { workspaceId: interaction.workspaceId }),
          ...(interaction.runner === undefined ? {} : { runner: interaction.runner }),
          operationId: this.#nextOperationId(),
        })
        return { consume: true }
      }
    }
    if (matchesKey(data, 'ctrl+c') && !this.#tui.hasOverlay()) {
      if (this.#editor.getText()) {
        this.#editor.setText('')
        return { consume: true }
      }
      if (this.#app.cancelActive()) return { consume: true }
      if (this.#quitArmed) this.stop()
      else this.#armQuit()
      return { consume: true }
    }
    return undefined
  }

  #armQuit(): void {
    this.#quitArmed = true
    if (this.#quitTimer) clearTimeout(this.#quitTimer)
    this.#quitTimer = setTimeout(() => {
      this.#quitTimer = undefined
      this.#quitArmed = false
      this.#render(this.#app.state())
    }, 2_000)
    this.#render(this.#app.state())
  }

  #disarmQuit(): void {
    if (!this.#quitArmed) return
    this.#quitArmed = false
    if (this.#quitTimer) clearTimeout(this.#quitTimer)
    this.#quitTimer = undefined
    this.#render(this.#app.state())
  }

  #openPalette(): void {
    if (this.#tui.hasOverlay()) return
    const palette = new CommandPalette(this.#theme, (command) => this.#handlePalette(command))
    const handle = this.#tui.showOverlay(palette, {
      anchor: 'center',
      width: '70%',
      minWidth: 28,
      maxHeight: 12,
    })
    this.#overlayClose = () => {
      handle.hide()
      this.#overlayClose = undefined
    }
  }

  #handlePalette(command: PaletteCommand): void {
    this.#overlayClose?.()
    if (command === 'quit') this.stop()
  }
}
