import {
  matchesKey,
  type TUI,
  type Editor,
} from '@earendil-works/pi-tui'
import type { BraidApplication } from '../../app/application.js'
import { parseAnalysisCommand } from '../../analysis/commands.js'
import { sanitizeDiagnosticText } from '../../analysis/diagnostics.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidState } from '../../domain/state.js'
import { CommandPalette, type PaletteCommand } from './command-palette.js'
import type { BraidTheme } from './theme.js'
import { BraidTerminalRenderer } from './terminal-renderer.js'

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
  readonly #renderer: BraidTerminalRenderer
  readonly #nextOperationId: () => string
  readonly #done: Promise<void>
  readonly #resolveDone: () => void
  readonly #unsubscribe: () => void
  readonly #removeInputListener: () => void
  #overlayClose: (() => void) | undefined
  #quitTimer: ReturnType<typeof setTimeout> | undefined
  #quitArmed = false
  #stopped = false
  #analysisStatus = ''
  #analysisFailed = false

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

    this.#renderer = new BraidTerminalRenderer({
      tui: this.#tui,
      theme: this.#theme,
      workspace: options.workspace,
      onSubmit: (text) => this.#submit(text),
    })
    this.#renderer.mount()
    this.#unsubscribe = this.#app.subscribe((state) => this.#render(state))
    this.#removeInputListener = this.#tui.addInputListener((data) => this.#handleGlobalInput(data))
    this.#render(this.#app.state())
  }

  get editor(): Editor {
    return this.#renderer.editor
  }

  get commandFailed(): boolean {
    return this.#analysisFailed
  }

  start(): Promise<void> {
    this.#tui.setFocus(this.#renderer.editor)
    this.#tui.start()
    return this.#done
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#quitTimer) {
      clearTimeout(this.#quitTimer)
      this.#quitTimer = undefined
    }
    this.#removeInputListener()
    this.#unsubscribe()
    this.#tui.stop()
    this.#resolveDone()
  }

  #render(state: BraidState): void {
    this.#renderer.render(state, {
      analysisStatus: this.#analysisStatus,
      quitArmed: this.#quitArmed,
    })
  }

  #submit(rawText: string): void {
    const text = rawText.trim()
    if (!text) return
    if (text === '/quit') {
      this.stop()
      return
    }
    if (text === '/help') {
      this.#openPalette()
      return
    }
    if (text === '/graph') {
      this.#renderer.editor.addToHistory(rawText)
      this.#renderer.editor.setText('')
      const graph = this.#app.graph()
      this.#analysisFailed = false
      this.#analysisStatus = `graph · ${graph.nodes.length} node(s) · ${graph.edges.length} edge(s) · ${graph.digest.slice(0, 16)}`
      this.#render(this.#app.state())
      return
    }
    if (text === '/cancel') {
      this.#renderer.editor.addToHistory(rawText)
      this.#renderer.editor.setText('')
      this.#analysisFailed = !this.#app.cancelActive()
      this.#analysisStatus = this.#analysisFailed
        ? 'no active run to cancel'
        : 'cancellation requested'
      this.#render(this.#app.state())
      return
    }
    if (text.startsWith('/supervisor ')) {
      this.#renderer.editor.addToHistory(rawText)
      this.#renderer.editor.setText('')
      const supervisorId = text.slice('/supervisor '.length).trim()
      if (!supervisorId || supervisorId.length > 256) {
        this.#analysisFailed = true
        this.#analysisStatus = 'supervisor requires a bounded identifier'
        this.#render(this.#app.state())
        return
      }
      this.#analysisStatus = 'loading supervisor'
      this.#render(this.#app.state())
      void this.#app
        .supervisorSnapshot(supervisorId)
        .then((snapshot) => {
          this.#analysisFailed = false
          this.#analysisStatus = `supervisor ${snapshot.status} · ${snapshot.workers.length} worker(s) · revision ${snapshot.revision}`
        })
        .catch((error: unknown) => this.#setControlError('supervisor failed', error))
        .finally(() => this.#render(this.#app.state()))
      return
    }
    if (text.startsWith('/cancel-worker ')) {
      const parts = text.slice('/cancel-worker '.length).trim().split(/\s+/u)
      const [supervisorId, runId, maybeWorkerId, ...reasonParts] = parts
      if (!supervisorId || !runId || !maybeWorkerId) {
        this.#analysisFailed = true
        this.#analysisStatus = 'cancel-worker requires supervisor, run, and worker identifiers'
        this.#render(this.#app.state())
        return
      }
      const workerId = maybeWorkerId === '-' ? undefined : maybeWorkerId
      const reason = reasonParts.filter(Boolean).join(' ') || 'Cancelled by user'
      this.#renderer.editor.addToHistory(rawText)
      this.#renderer.editor.setText('')
      this.#analysisStatus = 'cancellation requested'
      this.#render(this.#app.state())
      void this.#app
        .cancelWorker({
          operationId: this.#nextOperationId(),
          supervisorId,
          runId,
          ...(workerId ? { workerId } : {}),
          reason,
        })
        .then((receipt) => {
          this.#analysisFailed = false
          this.#analysisStatus = `worker cancellation ${receipt.replayed ? 'replayed' : 'accepted'}`
        })
        .catch((error: unknown) => this.#setControlError('worker cancellation failed', error))
        .finally(() => this.#render(this.#app.state()))
      return
    }

    if (text.startsWith('/')) {
      const parsed = parseAnalysisCommand(text)
      if (!parsed) {
        this.#analysisFailed = true
        this.#analysisStatus = 'unknown command'
        this.#render(this.#app.state())
        return
      }
      if (parsed.status === 'invalid') {
        this.#analysisFailed = true
        this.#analysisStatus = parsed.message
        this.#render(this.#app.state())
        return
      }
      this.#renderer.editor.addToHistory(rawText)
      this.#renderer.editor.setText('')
      this.#analysisStatus = 'analysis running'
      this.#render(this.#app.state())
      if (parsed.command.command === 'compare') {
        void this.#app
          .compareSources({
            operationId: this.#nextOperationId(),
            baselineSourceId: parsed.command.baselineSourceId,
            treatmentSourceId: parsed.command.treatmentSourceId,
          })
          .then((result) => {
            this.#analysisFailed = false
            this.#analysisStatus = `comparison complete · ${result.pairs.length} pair(s)`
          })
          .catch((error: unknown) => this.#setControlError('comparison failed', error))
          .finally(() => this.#render(this.#app.state()))
        return
      }
      void this.#app
        .executeAnalysisCommand(parsed.command, this.#nextOperationId())
        .then((result) => {
          if ('status' in result) {
            this.#analysisFailed = result.status !== 'complete'
            this.#analysisStatus =
              result.status === 'complete'
                ? `analysis complete · ${result.findings.length} finding(s)`
                : `analysis ${result.status}: ${result.error?.message ?? 'failed'}`
            return
          }
          this.#analysisStatus = `fork created · ${result.branchId}`
        })
        .catch((error: unknown) => {
          this.#setControlError('analysis failed', error)
        })
        .finally(() => this.#render(this.#app.state()))
      return
    }

    this.#renderer.editor.addToHistory(rawText)
    this.#renderer.editor.setText('')
    try {
      const receipt = this.#app.send({ operationId: this.#nextOperationId(), text: rawText })
      void receipt.completion.finally(() => {
        this.#renderer.editor.disableSubmit = false
        this.#tui.requestRender()
      })
    } catch {
      this.#renderer.editor.setText(rawText)
      this.#tui.requestRender()
    }
  }

  #setControlError(prefix: string, error: unknown): void {
    this.#analysisFailed = true
    this.#analysisStatus = sanitizeTerminalText(
      `${prefix}: ${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}`,
    )
  }

  #handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (!matchesKey(data, 'ctrl+c')) this.#disarmQuit()
    if (matchesKey(data, 'ctrl+p')) {
      this.#openPalette()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+c') && !this.#tui.hasOverlay()) {
      if (this.#renderer.editor.getText()) {
        this.#renderer.editor.setText('')
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
    else if (command === 'graph' || command === 'cancel') {
      this.#renderer.editor.setText(`/${command}`)
      this.#tui.setFocus(this.#renderer.editor)
    } else if (command === 'supervisor') {
      this.#renderer.editor.setText('/supervisor ')
      this.#tui.setFocus(this.#renderer.editor)
    } else if (command === 'cancel-worker') {
      this.#renderer.editor.setText('/cancel-worker ')
      this.#tui.setFocus(this.#renderer.editor)
    } else if (command.startsWith('analysis:')) {
      const name = command.slice('analysis:'.length)
      this.#renderer.editor.setText(name === 'analyze' ? '/analyze ' : `/${name} `)
      this.#tui.setFocus(this.#renderer.editor)
    }
  }
}
