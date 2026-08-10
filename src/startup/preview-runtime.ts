import { basename } from 'node:path'
import { ProcessTerminal } from '@earendil-works/pi-tui/dist/terminal.js'
import type { Terminal } from '@earendil-works/pi-tui/dist/terminal.js'
import { CURSOR_MARKER, type Component, type TUI } from '@earendil-works/pi-tui/dist/tui.js'
import { TuiMainScreen } from '@earendil-works/pi-tui/dist/tui-main-screen.js'
import { Text } from '@earendil-works/pi-tui/dist/components/text.js'
import { AlternateScreenTerminal } from '../adapters/tui/alternate-screen-terminal.js'
import { boundVisibleText } from '../views/shared/sanitize.js'
import { installTerminalOutputPolicy } from '../views/tui/terminal-compatibility.js'
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
  readonly branchId: string
  readonly profile: {
    readonly name?: string
    readonly harness?: string
    readonly model?: { readonly default?: string }
  }
  readonly selectedConnectionId: string | null
  readonly connections: readonly { readonly id: string; readonly name: string }[]
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
  readonly #header: Text
  readonly #metadata: Text
  readonly #transcript: Text
  readonly #composer: Text
  readonly #input: string[] = []
  #inputBytes = 0
  #inputOverflowed = false
  focused = false

  constructor(state: StartupFrameState, workspace: string) {
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
    this.#header = new Text(`braid · ${basename(state.workspace ?? workspace)}`, 1, 0)
    this.#metadata = new Text(
      `${state.profile.name ?? 'AgentProfile'} · ${runner} · ${model} · ${connectionName} · ${status}`,
      1,
      0,
    )
    const messages = state.messages
      .filter((message) => message.branchId === state.branchId && message.status !== 'redacted')
      .slice(-MAX_PREVIEW_MESSAGES)
      .map(
        (message) => `${message.role === 'user' ? 'you' : 'braid'}\n${previewText(message.text)}`,
      )
      .join('\n\n')
    this.#transcript = new Text(messages || 'Write a message, or press Ctrl+P for commands.', 1, 1)
    this.#composer = new Text(`› ${CURSOR_MARKER}`, 1, 0)
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
    this.#header.invalidate()
    this.#metadata.invalidate()
    this.#transcript.invalidate()
    this.#composer.invalidate()
  }

  render(width: number): string[] {
    return [
      ...this.#header.render(width),
      ...this.#metadata.render(width),
      ...this.#transcript.render(width),
      ...this.#composer.render(width),
    ]
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
  const frame = new StartupFrame(input.state, input.workspace)
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
