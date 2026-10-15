import { VirtualTerminal } from './virtual-terminal.js'

type CastEvent = readonly [seconds: number, kind: 'i' | 'o', data: string]

/** Records a virtual terminal session as asciicast v2 for capture evidence. */
export class RecordingTerminal extends VirtualTerminal {
  readonly #events: CastEvent[] = []
  readonly #startedAt = performance.now()

  #record(kind: 'i' | 'o', data: string): void {
    const seconds = Number(((performance.now() - this.#startedAt) / 1_000).toFixed(6))
    this.#events.push([seconds, kind, data])
  }

  override write(data: string): void {
    this.#record('o', data)
    super.write(data)
  }

  override sendInput(data: string): void {
    this.#record('i', data)
    super.sendInput(data)
  }

  override moveBy(lines: number): void {
    if (lines !== 0) this.#record('o', lines > 0 ? `\u001b[${lines}B` : `\u001b[${-lines}A`)
    super.moveBy(lines)
  }

  override hideCursor(): void {
    this.#record('o', '\u001b[?25l')
    super.hideCursor()
  }

  override showCursor(): void {
    this.#record('o', '\u001b[?25h')
    super.showCursor()
  }

  override clearLine(): void {
    this.#record('o', '\u001b[K')
    super.clearLine()
  }

  override clearFromCursor(): void {
    this.#record('o', '\u001b[J')
    super.clearFromCursor()
  }

  override clearScreen(): void {
    this.#record('o', '\u001b[2J\u001b[H')
    super.clearScreen()
  }

  cast(title: string): string {
    const last = this.#events.at(-1)?.[0] ?? 0
    const settled: CastEvent[] = [...this.#events, [Number((last + 0.05).toFixed(6)), 'o', '']]
    const header = {
      version: 2,
      width: this.columns,
      height: this.rows,
      timestamp: Math.floor(Date.now() / 1_000),
      duration: settled.at(-1)?.[0] ?? 0,
      idle_time_limit: 1,
      command: 'Braid TUI with a controlled provider (not provider evidence)',
      title,
      env: { TERM: 'xterm-256color' },
      stdin: true,
    }
    return [JSON.stringify(header), ...settled.map((event) => JSON.stringify(event)), ''].join('\n')
  }
}
