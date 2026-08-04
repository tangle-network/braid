import type { Terminal } from '@earendil-works/pi-tui'

export interface KeyboardCompatibility {
  readonly kitty: boolean
  readonly fallback: boolean
  readonly message: string
}

type TerminalOutputTarget = Pick<Terminal, 'setProgress' | 'setTitle' | 'write'>

const MAX_METADATA_BYTES = 4096

class TerminalMetadataFilter {
  #state: 'normal' | 'escape' | 'osc' | 'oscEscape' | 'oscDiscard' | 'oscDiscardEscape' = 'normal'
  #controlBytes = 0

  push(input: string): string {
    let output = ''
    for (const character of input) {
      if (this.#state === 'normal') {
        if (character === '\u001b') this.#state = 'escape'
        else if (character === '\u009d') this.#startOsc()
        else output += character
        continue
      }
      if (this.#state === 'escape') {
        if (character === ']') this.#startOsc()
        else {
          output += `\u001b${character}`
          this.#state = 'normal'
        }
        continue
      }
      if (this.#state === 'oscDiscard' || this.#state === 'oscDiscardEscape') {
        this.#consumeDiscardedOsc(character)
        continue
      }
      if (this.#state === 'osc') {
        if (isOscTerminator(character)) this.#reset()
        else if (character === '\u001b')
          this.#state = this.#exceedsMetadataLimit() ? 'oscDiscardEscape' : 'oscEscape'
        else if (this.#exceedsMetadataLimit()) this.#state = 'oscDiscard'
        continue
      }
      if (character === '\\' || isOscTerminator(character)) this.#reset()
      else if (character === '\u001b')
        this.#state = this.#exceedsMetadataLimit() ? 'oscDiscardEscape' : 'oscEscape'
      else this.#state = this.#exceedsMetadataLimit() ? 'oscDiscard' : 'osc'
    }
    return output
  }

  #exceedsMetadataLimit(): boolean {
    this.#controlBytes += 1
    return this.#controlBytes > MAX_METADATA_BYTES
  }

  #consumeDiscardedOsc(character: string): void {
    if (isOscTerminator(character)) {
      this.#reset()
      return
    }
    if (this.#state === 'oscDiscard') {
      if (character === '\u001b') this.#state = 'oscDiscardEscape'
      return
    }
    if (character === '\\') this.#reset()
    else if (character !== '\u001b') this.#state = 'oscDiscard'
  }

  #startOsc(): void {
    this.#state = 'osc'
    this.#controlBytes = 2
  }

  #reset(): void {
    this.#state = 'normal'
    this.#controlBytes = 0
  }
}

function isOscTerminator(character: string): boolean {
  return character === '\u0007' || character === '\u009c'
}

export function installTerminalOutputPolicy(
  terminal: TerminalOutputTarget,
  suppressMetadata: boolean,
): () => void {
  if (!suppressMetadata) return () => {}
  const originalWrite = terminal.write.bind(terminal)
  const originalSetTitle = terminal.setTitle.bind(terminal)
  const originalSetProgress = terminal.setProgress.bind(terminal)
  const filter = new TerminalMetadataFilter()
  const filteredWrite = (data: string): void => {
    const safeData = filter.push(data)
    if (safeData) originalWrite(safeData)
  }
  terminal.write = filteredWrite
  terminal.setTitle = () => {}
  terminal.setProgress = () => {}
  return () => {
    if (terminal.write === filteredWrite) terminal.write = originalWrite
    if (terminal.setTitle !== originalSetTitle) terminal.setTitle = originalSetTitle
    if (terminal.setProgress !== originalSetProgress) terminal.setProgress = originalSetProgress
  }
}

export function keyboardCompatibility(
  terminal: Pick<Terminal, 'kittyProtocolActive'> & {
    readonly modifyOtherKeysActive?: boolean
  },
): KeyboardCompatibility {
  if (terminal.kittyProtocolActive) {
    return Object.freeze({
      kitty: true,
      fallback: true,
      message: 'keyboard: Kitty protocol negotiated; legacy fallback remains available',
    })
  }
  const modifiedKeys = terminal.modifyOtherKeysActive === true
  return Object.freeze({
    kitty: false,
    fallback: true,
    message: modifiedKeys
      ? 'keyboard: Kitty protocol unavailable; modified-key legacy fallback is active'
      : 'keyboard: Kitty protocol unavailable; legacy key sequences remain active',
  })
}
