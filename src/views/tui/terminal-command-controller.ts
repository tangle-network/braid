import type { Editor } from '@earendil-works/pi-tui'
import {
  type AnalysisSourceReference,
  parseAnalysisSourceReference,
} from '../../app/analysis-source.js'
import {
  type CommandName,
  commandAvailability,
  commandIntent,
  isMutatingCommand,
  parseCommandInput,
} from '../shared/command-registry.js'
import type { BraidIntent, BraidUiController, UiDispatchResult } from '../shared/intents.js'
import type { BraidViewModel } from '../shared/models.js'
import type { NativeInteractiveUiActions } from '../shared/native-interactive-actions.js'
import type { ComposerMode } from './composer-view.js'
import { executionTargetFor } from './execution-target.js'
import type { TerminalDraftController } from './terminal-drafts.js'
import type { TerminalOverlayController } from './terminal-overlays.js'

export interface TerminalCommandControllerOptions {
  readonly controller: BraidUiController
  readonly editor: Editor
  readonly drafts: TerminalDraftController
  readonly overlays: TerminalOverlayController
  readonly nextOperationId: () => string
  readonly dispatch: (intent: BraidIntent, restoreText?: string) => Promise<UiDispatchResult>
  readonly isStopped: () => boolean
  readonly stop: () => void
  readonly composerMode: () => ComposerMode
  readonly nativeInteractive?: NativeInteractiveUiActions
}

/** Owns prompt parsing and command routing; it never owns terminal layout. */
export class TerminalCommandController {
  readonly #controller: BraidUiController
  readonly #editor: Editor
  readonly #drafts: TerminalDraftController
  readonly #overlays: TerminalOverlayController
  readonly #nextOperationId: () => string
  readonly #dispatch: TerminalCommandControllerOptions['dispatch']
  readonly #isStopped: () => boolean
  readonly #stop: () => void
  readonly #composerMode: () => ComposerMode
  readonly #nativeInteractive: NativeInteractiveUiActions | undefined

  constructor(options: TerminalCommandControllerOptions) {
    this.#controller = options.controller
    this.#editor = options.editor
    this.#drafts = options.drafts
    this.#overlays = options.overlays
    this.#nextOperationId = options.nextOperationId
    this.#dispatch = options.dispatch
    this.#isStopped = options.isStopped
    this.#stop = options.stop
    this.#composerMode = options.composerMode
    this.#nativeInteractive = options.nativeInteractive
  }

  submit(rawText: string): void {
    void this.#submitValue(rawText)
  }

  dispatchCommand(command: CommandName, args: readonly string[]): void {
    void this.#dispatchCommandValue(command, args)
  }

  async #submitValue(rawText: string): Promise<void> {
    if (!rawText.trim()) return
    const parsed = parseCommandInput(rawText)
    if (parsed.kind === 'unknown') {
      this.#overlays.openCorrection(parsed.name, parsed.suggestions)
      return
    }
    if (parsed.kind === 'invalid') {
      this.#overlays.openUnavailable('Invalid command', parsed.message)
      return
    }
    if (parsed.kind === 'command') {
      this.#editor.addToHistory(rawText)
      this.#drafts.setText('')
      await this.#drafts.flush('')
      this.dispatchCommand(parsed.name, parsed.args)
      return
    }

    const view = this.#controller.view()
    const active = view.activeRunId !== undefined
    const queueCapability = view.capabilities['run.queue']
    const steerCapability = view.capabilities['run.steer']
    const queueAvailable = active && queueCapability?.available === true
    const steerAvailable = active && steerCapability?.available === true
    const steerSelected = steerAvailable && (!queueAvailable || this.#composerMode() === 'steer')
    const capability = active
      ? steerSelected
        ? steerCapability
        : queueCapability
      : view.capabilities['run.send']
    if (!capability?.available) {
      this.#editor.setText(rawText)
      this.#overlays.openUnavailable(
        active && this.#composerMode() === 'steer'
          ? 'Steering unavailable'
          : active
            ? 'Queue unavailable'
            : 'Send unavailable',
        capability?.reason ?? 'The current connection cannot accept this message',
      )
      return
    }
    this.#editor.addToHistory(rawText)
    await this.#drafts.flush(rawText)
    this.#drafts.setText('')
    const operationId = this.#nextOperationId()
    const intent: BraidIntent = !active
      ? { type: 'send', operationId, text: parsed.text }
      : steerSelected
        ? steerIntent(operationId, parsed.text, view.activeRunId)
        : {
            type: 'queue',
            operationId,
            text: parsed.text,
            ...(view.activeRunId === undefined ? {} : { runId: view.activeRunId }),
          }
    void this.#dispatch(intent, rawText)
  }

  async #dispatchCommandValue(command: CommandName, args: readonly string[]): Promise<void> {
    if (command === 'interactive' || command === 'attach') {
      await this.#runNativeInteractive(command, args)
      return
    }
    if (command === 'profile' && args.length === 0) {
      this.#overlays.openProfile()
      return
    }
    if (command === 'connection' && args.length === 0) {
      this.#overlays.openConnection()
      return
    }
    if (command === 'connection' && args[0] === 'create') {
      this.#overlays.openConnectionEditor()
      return
    }
    if (
      (command === 'runner' || command === 'model' || command === 'effort') &&
      args.length === 0
    ) {
      this.#overlays.openSelector(command)
      return
    }
    if (
      command === 'automate' &&
      (args.length === 0 || (args.length === 1 && args[0] === 'list'))
    ) {
      this.#overlays.openAutomation()
      return
    }
    if (command !== 'approve' && command !== 'reject') {
      const availability = commandAvailability(command, this.#controller.view().capabilities)
      if (!availability.available) {
        this.#overlays.openUnavailable(
          `/${command}`,
          availability.reason ?? 'Capability is unavailable',
        )
        return
      }
    }
    if (['new', 'open', 'branch', 'clone', 'fork'].includes(command)) await this.#drafts.flush()
    if (command === 'open') {
      this.#overlays.openConversationSelector(args.join(' ').trim())
      return
    }
    if (command === 'ask' && args.length > 0 && !isExplicitAnalysisSource(args[0])) {
      const sources = this.#controller
        .view()
        .activity.filter(
          (item) =>
            item.kind === 'run' && (item.status === 'completed' || item.status === 'failed'),
        )
      if (sources.length > 1) {
        this.#overlays.openAnalysisSource(args, sources)
        return
      }
    }
    const operationId = isMutatingCommand(command) ? this.#nextOperationId() : undefined
    if (command === 'steer') {
      if (operationId === undefined) {
        this.#overlays.openUnavailable('/steer', 'Steering requires an operation identifier')
        return
      }
      void this.#dispatch(
        steerIntent(operationId, args.join(' '), this.#controller.view().activeRunId),
      )
      return
    }
    const intent = commandIntent(command, args, operationId)
    if (intent.type === 'open-surface') {
      void this.#dispatch(intent).then((result) => {
        if (result.kind !== 'accepted' || this.#isStopped()) return
        if (intent.surface === 'help') this.#overlays.openHelp(intent.query ?? '')
        else this.#overlays.openSurface(intent.surface)
      })
      return
    }
    if (intent.type === 'shutdown') {
      void this.#dispatch(intent).then((result) => {
        if (result.kind === 'accepted') this.#stop()
      })
      return
    }
    const intelligenceProgress =
      command === 'ask' || command === 'analyze' || command === 'compare'
        ? this.#overlays.openIntelligenceProgress(
            command,
            intelligenceSourceContext(command, args, this.#controller.view()),
          )
        : undefined
    void this.#dispatch(intent).then((result) => {
      if (result.kind !== 'accepted' || this.#isStopped()) return
      if (command === 'fork') this.#overlays.openSurface('fork')
      else if (command === 'ask' || command === 'analyze' || command === 'compare') {
        intelligenceProgress?.complete(result.data)
      }
    })
  }

  async #runNativeInteractive(
    command: 'interactive' | 'attach',
    args: readonly string[],
  ): Promise<void> {
    const action = command === 'interactive' ? 'start' : 'attach'
    const actions = this.#nativeInteractive
    if (actions === undefined) {
      this.#overlays.openUnavailable(
        `/${command}`,
        'Native terminal mode is unavailable in this interface',
      )
      return
    }
    const availability = actions.availability(action)
    if (!availability.available) {
      this.#overlays.openUnavailable(`/${command}`, availability.reason ?? 'Unavailable')
      return
    }
    await this.#drafts.flush()
    let result: Awaited<ReturnType<NativeInteractiveUiActions['run']>>
    try {
      result = await actions.run(
        command === 'interactive'
          ? {
              action: 'start',
              ...(args.length === 0 ? {} : { initialPrompt: args.join(' ') }),
            }
          : { action: 'attach', ...(args[0] === undefined ? {} : { runId: args[0] }) },
      )
    } catch (error) {
      this.#overlays.openUnavailable(
        `/${command}`,
        error instanceof Error ? error.message : 'Native terminal operation failed',
      )
      return
    }
    if (result.kind === 'unavailable') {
      this.#overlays.openUnavailable(`/${command}`, result.reason)
    } else if (result.kind === 'error') {
      this.#overlays.openUnavailable(`/${command}`, result.message)
    }
  }
}

function steerIntent(
  operationId: string,
  text: string,
  runId: string | undefined,
): Extract<BraidIntent, { type: 'steer' }> {
  return { type: 'steer', operationId, text, ...(runId === undefined ? {} : { runId }) }
}

function isExplicitAnalysisSource(value: string | undefined): boolean {
  return value === undefined ? false : parseAnalysisSourceReference(value) !== undefined
}

function intelligenceSourceContext(
  command: 'ask' | 'analyze' | 'compare',
  args: readonly string[],
  view: BraidViewModel,
): string | undefined {
  if (command === 'compare') {
    const left = sourceReferenceForArgument(args[0], view)
    const right = sourceReferenceForArgument(args[1], view)
    return left === undefined || right === undefined
      ? undefined
      : `sources ${displaySourceReference(left)} ↔ ${displaySourceReference(right)}`
  }
  const source = sourceReferenceForArgument(args[0], view) ?? latestTerminalSource(view)
  if (source === undefined) return undefined
  if (source.kind === 'branch') return `source ${displaySourceReference(source)}`
  const target = executionTargetFor(view, source.id)
  return `source ${displaySourceReference(source)} · ${target.profileName} · ${target.runner} · ${target.model} · ${target.connection}`
}

function displaySourceReference(source: AnalysisSourceReference): string {
  const id = source.id.length <= 24 ? source.id : `${source.id.slice(0, 12)}…${source.id.slice(-6)}`
  return `${source.kind} ${id}`
}

function sourceReferenceForArgument(
  value: string | undefined,
  view: BraidViewModel,
): AnalysisSourceReference | undefined {
  if (value === undefined) return undefined
  const parsed = parseAnalysisSourceReference(value)
  if (parsed !== undefined) return parsed
  if (view.runs.some((run) => run.id === value)) return { kind: 'run', id: value }
  if (
    view.branch === value ||
    view.graph.some((node) => node.type === 'branch' && node.id === value)
  ) {
    return { kind: 'branch', id: value }
  }
  return undefined
}

function latestTerminalSource(view: BraidViewModel): AnalysisSourceReference | undefined {
  const id = view.runs
    .slice()
    .reverse()
    .find((run) => run.status === 'completed' || run.status === 'failed')?.id
  return id === undefined ? undefined : { kind: 'run', id }
}
