import { utf8ByteLength } from './utf8.js'

const BIDI_CONTROLS = /\p{Bidi_Control}/u
const BEARER_PREFIX = 'bearer'
const URL_PREFIXES = ['http://', 'https://'] as const
const SENSITIVE_NAME =
  /(?:password|passwd|passphrase|token|secret|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|signature|session[_-]?id|jwt|auth[_-]?code|bearer|nonce|answer|challenge|headers?|cookies?|query)/iu

export const MAX_SANITIZER_PENDING_BYTES = 64 * 1024
export const MAX_SANITIZER_CONTROL_BYTES = 64 * 1024

type TerminalState =
  | 'normal'
  | 'escape'
  | 'escape-intermediate'
  | 'csi'
  | 'osc'
  | 'osc-escape'
  | 'string'
  | 'string-escape'

type RedactionState =
  | 'normal'
  | 'bearer-prefix'
  | 'bearer-gap'
  | 'bearer-token'
  | 'bearer-discard'
  | 'url-prefix'
  | 'url-body'
  | 'url-discard'

export interface IncrementalSanitizerOptions {
  readonly stripControls?: boolean
}

function isCancellation(code: number): boolean {
  return code === 0x18 || code === 0x1a
}

function isIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/u.test(character)
}

const isHighSurrogate = (character: string): boolean =>
  character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdbff

const isLowSurrogate = (character: string): boolean =>
  character.length === 1 && character.charCodeAt(0) >= 0xdc00 && character.charCodeAt(0) <= 0xdfff

function isUrlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return code > 0x20 && code !== 0x7f && !/[<>"']/u.test(character)
}

function isC1Introducer(code: number): TerminalState | undefined {
  switch (code) {
    case 0x9b:
      return 'csi'
    case 0x9d:
      return 'osc'
    case 0x90:
    case 0x98:
    case 0x9e:
    case 0x9f:
      return 'string'
    default:
      return undefined
  }
}

function safeUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    if (url.username || url.password) return false
    for (const key of url.searchParams.keys()) if (SENSITIVE_NAME.test(key)) return false
    const fragment = url.hash.slice(1)
    if (fragment) {
      const parameters = new URLSearchParams(fragment)
      for (const key of parameters.keys()) if (SENSITIVE_NAME.test(key)) return false
    }
    return true
  } catch {
    return false
  }
}

function redactUrl(candidate: string): string {
  let url = candidate
  let suffix = ''
  while (/[),.;!?\]}]$/u.test(url)) {
    suffix = `${url.at(-1)}${suffix}`
    url = url.slice(0, -1)
  }
  return safeUrl(url) ? candidate : `[redacted link]${suffix}`
}

function startsWithIgnoreCase(value: string, prefix: string): boolean {
  return prefix.startsWith(value.toLowerCase())
}

/** Sanitizes controls and credential-bearing text with bounded pending data. */
export class IncrementalSanitizer {
  readonly #stripControls: boolean
  #terminalState: TerminalState = 'normal'
  #controlBytes = 0
  #controlOverflowed = false
  #redactionState: RedactionState = 'normal'
  #pending = ''
  #pendingBytes = 0
  #lastCharacter: string | undefined
  #pendingHighSurrogate: string | undefined

  constructor(options: IncrementalSanitizerOptions = {}) {
    this.#stripControls = options.stripControls ?? true
  }

  get failedClosed(): boolean {
    return this.#controlOverflowed
  }

  push(input: string): string {
    if (input.length === 0) return ''
    const output: string[] = []
    for (const character of input) this.#consumeInputCharacter(character, output)
    return output.join('')
  }

  /** Flushes the current text part and resets all state for its next lifetime. */
  finish(): string {
    const output: string[] = []
    this.#flushPendingSurrogate(output)
    this.#finishRedaction(output)
    this.reset()
    return output.join('')
  }

  flush(): string {
    return this.finish()
  }

  reset(): void {
    this.#terminalState = 'normal'
    this.#controlBytes = 0
    this.#controlOverflowed = false
    this.#redactionState = 'normal'
    this.#pending = ''
    this.#pendingBytes = 0
    this.#lastCharacter = undefined
    this.#pendingHighSurrogate = undefined
  }

  #consumeInputCharacter(character: string, output: string[]): void {
    if (this.#pendingHighSurrogate !== undefined) {
      if (isLowSurrogate(character)) {
        const pair = `${this.#pendingHighSurrogate}${character}`
        this.#pendingHighSurrogate = undefined
        this.#consume(pair, output)
        return
      }
      this.#flushPendingSurrogate(output)
    }
    if (isHighSurrogate(character)) {
      this.#pendingHighSurrogate = character
      return
    }
    this.#consume(character, output)
  }

  #flushPendingSurrogate(output: string[]): void {
    if (this.#pendingHighSurrogate === undefined) return
    this.#pendingHighSurrogate = undefined
    this.#consume('\ufffd', output)
  }

  #consume(character: string, output: string[]): void {
    if (!this.#stripControls) {
      this.#consumeRedaction(character, output)
      return
    }
    if (this.#terminalState === 'normal') {
      this.#consumeNormal(character, output)
      return
    }
    const code = character.codePointAt(0) ?? 0
    this.#countControl(character)
    if (this.#consumeControl(character, code, output)) return
  }

  #consumeNormal(character: string, output: string[]): void {
    const code = character.codePointAt(0) ?? 0
    if (character === '\u001b') {
      this.#beginControl('escape', character)
      return
    }
    const c1State = isC1Introducer(code)
    if (c1State) {
      this.#beginControl(c1State, character)
      return
    }
    if (code >= 0x80 && code <= 0x9f) return
    if (code === 0x9c || code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a)) {
      return
    }
    if (BIDI_CONTROLS.test(character)) return
    this.#consumeRedaction(character, output)
  }

  #consumeControl(character: string, code: number, output: string[]): boolean {
    switch (this.#terminalState) {
      case 'escape':
        if (character === '\u001b') return true
        {
          const c1State = isC1Introducer(code)
          if (c1State) {
            this.#terminalState = c1State
            return true
          }
        }
        if (code === 0x9c || isCancellation(code)) {
          this.#endControl()
          return true
        }
        if (character === '[') this.#terminalState = 'csi'
        else if (character === ']') this.#terminalState = 'osc'
        else if (character === 'P' || character === 'X' || character === '^' || character === '_')
          this.#terminalState = 'string'
        else if (isIntermediate(code)) this.#terminalState = 'escape-intermediate'
        else if (code >= 0x30 && code <= 0x7e) this.#endControl()
        else if (code > 0x9f) {
          this.#endControl()
          this.#consumeNormal(character, output)
        } else this.#endControl()
        return true
      case 'escape-intermediate': {
        if (character === '\u001b') {
          this.#beginControl('escape', character)
          return true
        }
        const c1State = isC1Introducer(code)
        if (c1State) {
          this.#terminalState = c1State
          return true
        }
        if (code === 0x9c || isCancellation(code)) {
          this.#endControl()
          return true
        }
        if (isIntermediate(code)) return true
        if (code >= 0x30 && code <= 0x7e) this.#endControl()
        else if (code > 0x9f) {
          this.#endControl()
          this.#consumeNormal(character, output)
        } else this.#endControl()
        return true
      }
      case 'csi':
        if (character === '\u001b') {
          this.#beginControl('escape', character)
          return true
        }
        if (code === 0x9c || isCancellation(code)) {
          this.#endControl()
          return true
        }
        {
          const c1State = isC1Introducer(code)
          if (c1State) {
            this.#terminalState = c1State
            return true
          }
        }
        if (code >= 0x40 && code <= 0x7e) this.#endControl()
        return true
      case 'osc':
        if (character === '\u0007' || code === 0x9c || isCancellation(code)) this.#endControl()
        else if (character === '\u001b') this.#terminalState = 'osc-escape'
        return true
      case 'osc-escape':
        if (character === '\\' || code === 0x9c || isCancellation(code)) this.#endControl()
        else if (character !== '\u001b') this.#terminalState = 'osc'
        return true
      case 'string':
        if (code === 0x9c || isCancellation(code)) this.#endControl()
        else if (character === '\u001b') this.#terminalState = 'string-escape'
        return true
      case 'string-escape':
        if (character === '\\' || code === 0x9c || isCancellation(code)) this.#endControl()
        else if (character !== '\u001b') this.#terminalState = 'string'
        return true
      case 'normal':
        return false
      default: {
        const exhaustive: never = this.#terminalState
        return exhaustive
      }
    }
  }

  #beginControl(state: TerminalState, introducer: string): void {
    this.#terminalState = state
    this.#controlBytes = utf8ByteLength(introducer)
    this.#controlOverflowed = false
  }

  #countControl(character: string): void {
    if (this.#controlOverflowed) return
    this.#controlBytes += utf8ByteLength(character)
    if (this.#controlBytes > MAX_SANITIZER_CONTROL_BYTES) {
      this.#controlBytes = MAX_SANITIZER_CONTROL_BYTES
      this.#controlOverflowed = true
    }
  }

  #endControl(): void {
    this.#terminalState = 'normal'
    this.#controlBytes = 0
    this.#controlOverflowed = false
  }

  #consumeRedaction(character: string, output: string[]): void {
    const current = character
    while (true) {
      if (this.#redactionState === 'normal') {
        if (current.toLowerCase() === 'b' && !isWordCharacter(this.#lastCharacter)) {
          this.#redactionState = 'bearer-prefix'
          this.#append(current)
          this.#lastCharacter = current
          return
        }
        if (current.toLowerCase() === 'h') {
          this.#redactionState = 'url-prefix'
          this.#append(current)
          this.#lastCharacter = current
          return
        }
        output.push(current)
        this.#lastCharacter = current
        return
      }
      if (this.#redactionState === 'bearer-prefix') {
        const candidate = `${this.#pending}${current}`
        if (!startsWithIgnoreCase(candidate, BEARER_PREFIX)) {
          this.#emitPending(output)
          continue
        }
        this.#append(current)
        this.#lastCharacter = current
        if (this.#pending.length === BEARER_PREFIX.length) this.#redactionState = 'bearer-gap'
        return
      }
      if (this.#redactionState === 'bearer-gap') {
        if (/\s/u.test(current)) {
          this.#append(current)
          this.#lastCharacter = current
          return
        }
        if (this.#pending.length === BEARER_PREFIX.length) {
          this.#emitPending(output)
          continue
        }
        if (/[,;]/u.test(current)) {
          this.#emitPending(output)
          continue
        }
        this.#redactionState = 'bearer-token'
        this.#append(current)
        this.#lastCharacter = current
        if (this.#pendingBytes > MAX_SANITIZER_PENDING_BYTES) this.#discardBearer(output)
        return
      }
      if (this.#redactionState === 'bearer-token') {
        if (/\s|[,;]/u.test(current)) {
          output.push('[redacted bearer]')
          this.#clearPending()
          this.#redactionState = 'normal'
          continue
        }
        this.#append(current)
        this.#lastCharacter = current
        if (this.#pendingBytes > MAX_SANITIZER_PENDING_BYTES) this.#discardBearer(output)
        return
      }
      if (this.#redactionState === 'bearer-discard') {
        if (/\s|[,;]/u.test(current)) {
          this.#redactionState = 'normal'
          continue
        }
        this.#lastCharacter = current
        return
      }
      if (this.#redactionState === 'url-prefix') {
        const candidate = `${this.#pending}${current}`
        if (!URL_PREFIXES.some((prefix) => startsWithIgnoreCase(candidate, prefix))) {
          this.#emitPending(output)
          continue
        }
        this.#append(current)
        this.#lastCharacter = current
        if (URL_PREFIXES.some((prefix) => prefix === candidate.toLowerCase())) {
          this.#redactionState = 'url-body'
        }
        return
      }
      if (this.#redactionState === 'url-body') {
        if (isUrlCharacter(current)) {
          this.#append(current)
          this.#lastCharacter = current
          if (this.#pendingBytes > MAX_SANITIZER_PENDING_BYTES) this.#discardUrl(output)
          return
        }
        output.push(redactUrl(this.#pending))
        this.#clearPending()
        this.#redactionState = 'normal'
        continue
      }
      if (this.#redactionState === 'url-discard') {
        if (!isUrlCharacter(current)) this.#redactionState = 'normal'
        else {
          this.#lastCharacter = current
          return
        }
        continue
      }
      const exhaustive: never = this.#redactionState
      throw new Error(`Unknown redaction state: ${exhaustive}`)
    }
  }

  #append(character: string): void {
    this.#pending += character
    this.#pendingBytes += utf8ByteLength(character)
  }

  #emitPending(output: string[]): void {
    output.push(this.#pending)
    this.#clearPending()
    this.#redactionState = 'normal'
  }

  #clearPending(): void {
    this.#pending = ''
    this.#pendingBytes = 0
  }

  #discardBearer(output: string[]): void {
    output.push('[redacted bearer]')
    this.#clearPending()
    this.#redactionState = 'bearer-discard'
  }

  #discardUrl(output: string[]): void {
    output.push('[redacted link]')
    this.#clearPending()
    this.#redactionState = 'url-discard'
  }

  #finishRedaction(output: string[]): void {
    switch (this.#redactionState) {
      case 'bearer-token':
        output.push('[redacted bearer]')
        break
      case 'bearer-discard':
        break
      case 'url-body':
        output.push(redactUrl(this.#pending))
        break
      case 'url-discard':
        break
      default:
        output.push(this.#pending)
        break
    }
  }
}

export function isSensitiveFieldName(input: string): boolean {
  return (
    SENSITIVE_NAME.test(input) ||
    /(?:mcp|attestation|confidential(?:ity)?|profile|credentials?)/iu.test(input)
  )
}

export function redactSensitiveText(input: string): string {
  const sanitizer = new IncrementalSanitizer()
  return `${sanitizer.push(input)}${sanitizer.finish()}`
}

export function redactSensitiveUrls(input: string): string {
  const sanitizer = new IncrementalSanitizer({ stripControls: false })
  return `${sanitizer.push(input)}${sanitizer.finish()}`
}
