const BIDI_CONTROLS = /\p{Bidi_Control}/gu

export function sanitizeTerminalText(input: string): string {
  let output = ''
  let state: 'normal' | 'escape' | 'csi' | 'osc' | 'string' | 'osc-escape' | 'string-escape' =
    'normal'

  for (const character of input) {
    const code = character.codePointAt(0) ?? 0
    switch (state) {
      case 'normal':
        if (character === '\u001b') {
          state = 'escape'
        } else if (character === '\u009b') {
          state = 'csi'
        } else if (character === '\u009d') {
          state = 'osc'
        } else if (character === '\u0090' || character === '\u0098' || character === '\u009e') {
          state = 'string'
        } else if (character === '\n' || character === '\t') {
          output += character
        } else if ((code >= 0x20 && code < 0x7f) || code > 0x9f) {
          output += character
        }
        break
      case 'escape':
        if (character === '[') state = 'csi'
        else if (character === ']') state = 'osc'
        else if (character === 'P' || character === '^' || character === '_') state = 'string'
        else state = 'normal'
        break
      case 'csi':
        if (code >= 0x40 && code <= 0x7e) state = 'normal'
        break
      case 'osc':
        if (character === '\u0007') state = 'normal'
        else if (character === '\u001b') state = 'osc-escape'
        break
      case 'string':
        if (character === '\u001b') state = 'string-escape'
        break
      case 'osc-escape':
        state = character === '\\' ? 'normal' : 'osc'
        break
      case 'string-escape':
        state = character === '\\' ? 'normal' : 'string'
        break
      default: {
        const exhaustive: never = state
        return exhaustive
      }
    }
  }

  return output.replace(BIDI_CONTROLS, '')
}
