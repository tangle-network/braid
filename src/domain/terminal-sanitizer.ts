const MAX_CONTROL_BYTES = 4096

type ControlState = 'normal' | 'escape' | 'csi' | 'osc' | 'string' | 'string-escape'

function isStringIntroducer(code: number): boolean {
  return code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f
}

function isC1(code: number): boolean {
  return code >= 0x80 && code <= 0x9f
}

/** Carries terminal-control state across arbitrary input chunks. */
export class TerminalControlSanitizer {
  #state: ControlState = 'normal'
  #controlBytes = 0

  push(input: string): string {
    let output = ''
    for (const character of input) {
      const code = character.codePointAt(0) ?? 0
      if (this.#state !== 'normal') {
        this.#consumeControl(character, code)
        continue
      }
      if (character === '\u001b') {
        this.#state = 'escape'
        this.#controlBytes = 1
      } else if (character === '\u009b') {
        this.#startControl('csi')
      } else if (character === '\u009d') {
        this.#startControl('osc')
      } else if (isStringIntroducer(code)) {
        this.#startControl('string')
      } else if (character === '\u009c' || code === 0x7f || code < 0x20) {
        if (character === '\n' || character === '\t') output += character
      } else if (!isC1(code)) {
        output += character
      }
    }
    return output
  }

  finish(): string {
    this.#state = 'normal'
    this.#controlBytes = 0
    return ''
  }

  #startControl(state: ControlState): void {
    this.#state = state
    this.#controlBytes = 1
  }

  #consumeControl(character: string, code: number): void {
    this.#controlBytes += 1
    if (this.#controlBytes > MAX_CONTROL_BYTES) {
      this.#state = 'normal'
      this.#controlBytes = 0
      return
    }
    if (this.#state === 'escape') {
      if (character === '[') this.#state = 'csi'
      else if (character === ']') this.#state = 'osc'
      else if (character === 'P' || character === 'X' || character === '^' || character === '_')
        this.#state = 'string'
      else this.#state = 'normal'
      return
    }
    if (this.#state === 'csi') {
      if (character === '\u009c' || (code >= 0x40 && code <= 0x7e)) this.#reset()
      return
    }
    if (this.#state === 'osc' || this.#state === 'string') {
      if (character === '\u0007' || character === '\u009c') this.#reset()
      else if (character === '\u001b') this.#state = 'string-escape'
      return
    }
    if (this.#state === 'string-escape') {
      this.#state = character === '\\' ? 'normal' : 'string'
    }
  }

  #reset(): void {
    this.#state = 'normal'
    this.#controlBytes = 0
  }
}

export function stripTerminalControls(input: string): string {
  const sanitizer = new TerminalControlSanitizer()
  return `${sanitizer.push(input)}${sanitizer.finish()}`
}
