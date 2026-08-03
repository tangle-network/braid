import { ProcessTerminal } from '@earendil-works/pi-tui'

const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h'
const LEAVE_ALTERNATE_SCREEN = '\u001b[?1049l'

export class AlternateScreenTerminal extends ProcessTerminal {
  #started = false
  #stopped = false

  override start(onInput: (data: string) => void, onResize: () => void): void {
    if (this.#started && !this.#stopped) return
    this.#started = true
    this.#stopped = false
    super.start(onInput, onResize)
    this.write(ENTER_ALTERNATE_SCREEN)
    this.clearScreen()
  }

  override stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.write(LEAVE_ALTERNATE_SCREEN)
    super.stop()
  }
}
