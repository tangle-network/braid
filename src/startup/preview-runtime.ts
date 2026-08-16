import { ProcessTerminal } from '@earendil-works/pi-tui/dist/terminal.js'
import type { Terminal } from '@earendil-works/pi-tui/dist/terminal.js'
import { CURSOR_MARKER, type Component, type TUI } from '@earendil-works/pi-tui/dist/tui.js'
import { TuiMainScreen } from '@earendil-works/pi-tui/dist/tui-main-screen.js'
import { Text } from '@earendil-works/pi-tui/dist/components/text.js'
import { AlternateScreenTerminal } from '../adapters/tui/alternate-screen-terminal.js'
import { boundVisibleText } from '../views/shared/sanitize.js'
import { installTerminalOutputPolicy } from '../views/tui/terminal-compatibility.js'
import { renderTerminalContext } from '../views/tui/terminal-identity.js'
import { createBraidTheme, type BraidTheme } from '../views/tui/theme.js'
import { createTerminalSignalLatch, type TerminalSignalExitCode } from './terminal-signal-latch.js'

const MAX_PREVIEW_MESSAGES = 4
const MAX_PREVIEW_MESSAGE_CHARS = 8_000
const MAX_STARTUP_INPUT_BYTES = 1024 * 1024

interface StartupMessage {
  readonly branchId: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly status: string
}

interface StartupRun {
  readonly branchId: string
  readonly status: string
  readonly updatedAt: string
}

export interface StartupFrameState {
  readonly workspace: string | null
  readonly conversationId?: string
  readonly branchId: string
  readonly profile: {
    readonly name?: string
    readonly harness?: string
    readonly model?: {
      readonly default?: string
      readonly reasoningEffort?: string
      readonly maxVisibleOutputTokens?: number
      readonly maxReasoningTokens?: number
      readonly maxTotalOutputTokens?: number
    }
  }
  readonly selectedConnectionId: string | null
  readonly connections: readonly { readonly id: string; readonly name: string }[]
  readonly conversations?: readonly {
    readonly id: string
    readonly title?: string | null
  }[]
  readonly messages: readonly StartupMessage[]
  readonly runs: readonly StartupRun[]
}

export interface StartupPreview {
  readonly tui: TUI
  readonly outputPolicyCleanup?: () => void
  readonly adopt: () => StartupPreviewHandoff
  readonly takeSignalOwnership: (handler: (exitCode: TerminalSignalExitCode) => void) => () => void
  readonly close: () => void
}

export interface StartupPreviewHandoff {
  readonly tui: TUI
  readonly input: readonly string[]
}

class StartupFrame implements Component {
  readonly #identity: Parameters<typeof renderTerminalContext>[1]
  readonly #transcript: Text
  readonly #theme: BraidTheme
  readonly #rows: () => number
  readonly #status: string
  readonly #input: string[] = []
  #inputBytes = 0
  #inputOverflowed = false
  focused = false

  constructor(state: StartupFrameState, workspace: string, rows: () => number, theme: BraidTheme) {
    const connection = state.connections.find(
      (candidate) => candidate.id === state.selectedConnectionId,
    )
    const branchRuns = state.runs
      .filter((run) => run.branchId === state.branchId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const status = branchRuns[0]?.status ?? 'ready'
    const runner = state.profile.harness ?? 'auto'
    const model = state.profile.model?.default ?? 'profile default'
    const connectionName = connection?.name ?? 'no connection'
    const conversation = state.conversations?.find(
      (candidate) => candidate.id === state.conversationId,
    )
    this.#identity = {
      workspace: state.workspace ?? workspace,
      conversationTitle: conversation?.title ?? 'New conversation',
      branch: state.branchId,
      profileName: state.profile.name ?? 'AgentProfile',
      runner,
      model,
      connection: connectionName,
      ...(state.profile.model?.reasoningEffort === undefined
        ? {}
        : { effort: state.profile.model.reasoningEffort }),
      ...(state.profile.model?.maxVisibleOutputTokens === undefined
        ? {}
        : { maxVisibleOutputTokens: state.profile.model.maxVisibleOutputTokens }),
      ...(state.profile.model?.maxReasoningTokens === undefined
        ? {}
        : { maxReasoningTokens: state.profile.model.maxReasoningTokens }),
      ...(state.profile.model?.maxTotalOutputTokens === undefined
        ? {}
        : { maxTotalOutputTokens: state.profile.model.maxTotalOutputTokens }),
    }
    this.#theme = theme
    this.#rows = rows
    this.#status = status
    const messages = state.messages
      .filter((message) => message.branchId === state.branchId && message.status !== 'redacted')
      .slice(-MAX_PREVIEW_MESSAGES)
      .map(
        (message) => `${message.role === 'user' ? 'you' : 'braid'}\n${previewText(message.text)}`,
      )
      .join('\n\n')
    this.#transcript = new Text(
      messages || `Ask ${state.profile.name ?? 'this AgentProfile'} anything.`,
      1,
      1,
    )
  }

  handleInput(data: string): void {
    if (this.#inputOverflowed) return
    const bytes = Buffer.byteLength(data, 'utf8')
    if (this.#inputBytes + bytes > MAX_STARTUP_INPUT_BYTES) {
      this.#input.length = 0
      this.#inputBytes = 0
      this.#inputOverflowed = true
      return
    }
    this.#input.push(data)
    this.#inputBytes += bytes
  }

  drainInput(): readonly string[] {
    const input = this.#inputOverflowed ? [] : [...this.#input]
    this.#input.length = 0
    this.#inputBytes = 0
    return Object.freeze(input)
  }

  invalidate(): void {
    this.#transcript.invalidate()
  }

  render(width: number): string[] {
    const rows = Math.max(1, Math.floor(this.#rows()))
    const footer = renderTerminalContext(
      this.#theme,
      this.#identity,
      [this.#theme.success(this.#status), this.#theme.text('Ctrl+P commands')],
      width,
    )
    const composer = [`${this.#theme.accent('›')}${CURSOR_MARKER}`, '', '']
    const contentRows = Math.max(0, rows - composer.length - 1)
    const transcript = contentRows === 0 ? [] : this.#transcript.render(width).slice(-contentRows)
    const content = [
      ...transcript,
      ...Array.from({ length: Math.max(0, contentRows - transcript.length) }, () => ''),
    ]
    return [...content, ...composer, footer].slice(-rows)
  }
}

function previewText(input: string): string {
  const safe = boundVisibleText(input)
  if (safe.length <= MAX_PREVIEW_MESSAGE_CHARS) return safe
  return `…\n${Array.from(safe).slice(-MAX_PREVIEW_MESSAGE_CHARS).join('')}`
}

export function createStartupPreview(input: {
  readonly state: StartupFrameState
  readonly workspace: string
  readonly inline: boolean
  readonly terminal?: Terminal
  readonly colors?: boolean
  readonly highContrast?: boolean
  readonly reducedMotion?: boolean
  readonly suppressMetadata?: boolean
}): StartupPreview {
  const terminal =
    input.terminal ?? (input.inline ? new ProcessTerminal() : new AlternateScreenTerminal())
  const restoreOutputPolicy = installTerminalOutputPolicy(terminal, input.suppressMetadata === true)
  let outputPolicyRestored = false
  const outputPolicyCleanup = () => {
    if (outputPolicyRestored) return
    outputPolicyRestored = true
    restoreOutputPolicy()
  }
  const tui = new TuiMainScreen(terminal)
  const frame = new StartupFrame(
    input.state,
    input.workspace,
    () => terminal.rows,
    createBraidTheme({
      ...(input.colors === undefined ? {} : { colors: input.colors }),
      ...(input.highContrast === undefined ? {} : { highContrast: input.highContrast }),
      ...(input.reducedMotion === undefined ? {} : { reducedMotion: input.reducedMotion }),
    }),
  )
  let removed = false
  let adopted = false
  let handoff: StartupPreviewHandoff | undefined
  let signalCleanup: (() => void) | undefined
  const remove = () => {
    if (removed) return
    removed = true
    tui.setFocus(null)
    tui.removeChild(frame)
  }
  const stopPreview = () => {
    remove()
    if (!adopted) tui.stop()
    outputPolicyCleanup()
  }
  const signals = createTerminalSignalLatch(stopPreview)
  tui.addChild(frame)
  tui.setFocus(frame)
  tui.start()
  tui.renderNow(true)
  return {
    tui,
    ...(input.suppressMetadata === true ? { outputPolicyCleanup } : {}),
    adopt: () => {
      if (handoff !== undefined) return handoff
      remove()
      adopted = true
      handoff = Object.freeze({ tui, input: frame.drainInput() })
      return handoff
    },
    takeSignalOwnership: (handler) => {
      signalCleanup ??= signals.takeOver(handler)
      return signalCleanup
    },
    close: () => {
      stopPreview()
      if (signalCleanup === undefined) signals.dispose()
    },
  }
}

export { ProcessTerminal, TuiMainScreen }
