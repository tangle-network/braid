import xterm from '@xterm/headless'

const XtermTerminal = xterm.Terminal

export class HeadlessTerminal {
  #xterm
  #inputHandler
  #resizeHandler
  #columns
  #rows

  constructor(columns = 80, rows = 24) {
    this.#columns = columns
    this.#rows = rows
    this.#xterm = new XtermTerminal({
      cols: columns,
      rows,
      disableStdin: true,
      allowProposedApi: true,
    })
  }

  get xterm() {
    return this.#xterm
  }

  start(onInput, onResize) {
    this.#inputHandler = onInput
    this.#resizeHandler = onResize
    this.#xterm.write('\u001b[?2004h')
  }

  stop() {
    this.#xterm.write('\u001b[?2004l')
    this.#inputHandler = undefined
    this.#resizeHandler = undefined
  }

  write(data) {
    this.#xterm.write(data)
  }

  get columns() {
    return this.#columns
  }

  get rows() {
    return this.#rows
  }

  get kittyProtocolActive() {
    return true
  }

  moveBy(lines) {
    if (lines > 0) this.#xterm.write(`\u001b[${lines}B`)
    else if (lines < 0) this.#xterm.write(`\u001b[${-lines}A`)
  }

  hideCursor() {
    this.#xterm.write('\u001b[?25l')
  }

  showCursor() {
    this.#xterm.write('\u001b[?25h')
  }

  clearLine() {
    this.#xterm.write('\u001b[K')
  }

  clearFromCursor() {
    this.#xterm.write('\u001b[J')
  }

  clearScreen() {
    this.#xterm.write('\u001b[2J\u001b[H')
  }

  setTitle(title) {
    this.#xterm.write(`\u001b]0;${title}\u0007`)
  }

  setProgress() {}

  sendInput(data) {
    this.#inputHandler?.(data)
  }

  resize(columns, rows) {
    this.#columns = columns
    this.#rows = rows
    this.#xterm.resize(columns, rows)
    this.#resizeHandler?.()
  }

  async flush() {
    await new Promise((resolve) => this.#xterm.write('', resolve))
  }

  getViewport() {
    const lines = []
    const buffer = this.#xterm.buffer.active
    for (let index = 0; index < this.#xterm.rows; index += 1) {
      const line = buffer.getLine(buffer.viewportY + index)
      lines.push(line?.translateToString(true) ?? '')
    }
    return lines
  }
}
