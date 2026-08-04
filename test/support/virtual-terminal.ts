/**
 * Copyright (c) 2025 Mario Zechner
 *
 * @derived-from https://github.com/earendil-works/pi
 * @source-commit a6f7317dfca61e357aee65faafe012a1be6c3734
 * @source-path packages/tui/test/virtual-terminal.ts
 * @source-license MIT
 * @adaptation Imports Pi's published Terminal type and follows Braid formatting.
 */

import type { Terminal } from '@earendil-works/pi-tui'
import type { Terminal as XtermTerminalType } from '@xterm/headless'
import xterm from '@xterm/headless'

const XtermTerminal = xterm.Terminal

export class VirtualTerminal implements Terminal {
  private xterm: XtermTerminalType
  private inputHandler: ((data: string) => void) | undefined
  private resizeHandler: (() => void) | undefined
  private _columns: number
  private _rows: number

  constructor(columns = 80, rows = 24) {
    this._columns = columns
    this._rows = rows
    this.xterm = new XtermTerminal({
      cols: columns,
      rows,
      disableStdin: true,
      allowProposedApi: true,
    })
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
    this.xterm.write('\u001b[?2004h')
  }

  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

  stop(): void {
    this.xterm.write('\u001b[?2004l')
    this.inputHandler = undefined
    this.resizeHandler = undefined
  }

  write(data: string): void {
    this.xterm.write(data)
  }

  get columns(): number {
    return this._columns
  }

  get rows(): number {
    return this._rows
  }

  get kittyProtocolActive(): boolean {
    return true
  }

  moveBy(lines: number): void {
    if (lines > 0) this.xterm.write(`\u001b[${lines}B`)
    else if (lines < 0) this.xterm.write(`\u001b[${-lines}A`)
  }

  hideCursor(): void {
    this.xterm.write('\u001b[?25l')
  }

  showCursor(): void {
    this.xterm.write('\u001b[?25h')
  }

  clearLine(): void {
    this.xterm.write('\u001b[K')
  }

  clearFromCursor(): void {
    this.xterm.write('\u001b[J')
  }

  clearScreen(): void {
    this.xterm.write('\u001b[2J\u001b[H')
  }

  setTitle(title: string): void {
    this.xterm.write(`\u001b]0;${title}\u0007`)
  }

  setProgress(_active: boolean): void {}

  sendInput(data: string): void {
    this.inputHandler?.(data)
  }

  resize(columns: number, rows: number): void {
    this._columns = columns
    this._rows = rows
    this.xterm.resize(columns, rows)
    this.resizeHandler?.()
  }

  async flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.xterm.write('', () => resolve())
    })
  }

  async flushAndGetViewport(): Promise<string[]> {
    await this.flush()
    return this.getViewport()
  }

  getViewport(): string[] {
    const lines: string[] = []
    const buffer = this.xterm.buffer.active
    for (let index = 0; index < this.xterm.rows; index += 1) {
      const line = buffer.getLine(buffer.viewportY + index)
      lines.push(line ? line.translateToString(true) : '')
    }
    return lines
  }

  getScrollBuffer(): string[] {
    const lines: string[] = []
    const buffer = this.xterm.buffer.active
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)
      lines.push(line ? line.translateToString(true) : '')
    }
    return lines
  }

  clear(): void {
    this.xterm.clear()
  }

  reset(): void {
    this.xterm.reset()
  }

  getCursorPosition(): { x: number; y: number } {
    const buffer = this.xterm.buffer.active
    return { x: buffer.cursorX, y: buffer.cursorY }
  }

  async waitForRender(): Promise<void> {
    await new Promise<void>((resolve) => process.nextTick(resolve))
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    await this.flush()
  }
}
