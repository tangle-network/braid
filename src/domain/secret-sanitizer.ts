import { TerminalControlSanitizer } from './terminal-sanitizer.js'

export const MAX_SANITIZED_TEXT_BYTES = 512 * 1024
export const SECRET_TRUNCATION_MARKER = '… [truncated]'
const MAX_PENDING_BYTES = 4096
const MAX_LOOKBEHIND_CHARS = 1024
const BIDI_CONTROLS = /\p{Bidi_Control}/gu
const BIDI_CHARACTER = /\p{Bidi_Control}/u
const SECRET_ASSIGNMENT =
  /(^|[\s,;{[(])(?:password|passwd|passphrase|token|secret|credential|authorization|auth|key|api[_ -]*key|access[_ -]*key|private[_ -]*key|client[_ -]*secret|signature|cookie|header|query|fragment)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\])}]*)/giu
const SECRET_AUTH_SCHEME_ASSIGNMENT =
  /(^|[\s,;{[(])(?:password|passwd|passphrase|token|secret|credential|authorization|auth|key|api[_ -]*key|access[_ -]*key|private[_ -]*key|client[_ -]*secret|signature|cookie|header|query|fragment)\s*[:=]\s*(?:Bearer|Basic)(?:\s+|\s*=\s*)[^\s,;}\])}]+/giu
const BEARER_ASSIGNMENT = /\bBearer(?:\s+|\s*=\s*)[^\s,;]*/giu
const BARE_CREDENTIAL =
  /(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})/gu
const WEB_URL = /https?:\/\/[^\s\p{Cc}<>"']+/giu
const INCOMPLETE_BEARER = /\bBearer(?:[\s]+|[\s]*=[\s]*)$/iu
const INCOMPLETE_URL = /(^|[\s([{<])https?:\/\/[^\s\p{Cc}<>"']*$/iu
const INCOMPLETE_ASSIGNMENT =
  /(^|[\s,;{[(])(?:password|passwd|passphrase|token|secret|credential|authorization|auth|key|api[_ -]*key|access[_ -]*key|private[_ -]*key|client[_ -]*secret|signature|cookie|header|query|fragment)\s*[:=]\s*(?:"[^"]*|'[^']*|[^\s,;}\])}]*)$/iu

const INCOMPLETE_BARE_CREDENTIAL =
  /(?:sk-|github_pat_|gh[pousr]_|AKIA|AIza|xox[baprs]-)[A-Za-z0-9_-]*$/u

const STREAM_BEARER_PREFIX = 'bearer'
const STREAM_URL_PREFIXES = ['http://', 'https://'] as const
const STREAM_SECRET_NAMES = [
  'password',
  'passwd',
  'passphrase',
  'token',
  'secret',
  'credential',
  'authorization',
  'auth',
  'key',
  'api_key',
  'api-key',
  'api key',
  'access_key',
  'access-key',
  'access key',
  'private_key',
  'private-key',
  'private key',
  'client_secret',
  'client-secret',
  'client secret',
  'signature',
  'cookie',
  'header',
  'query',
  'fragment',
] as const
const STREAM_BARE_PREFIXES = [
  { prefix: 'sk-', minimumBodyBytes: 20 },
  { prefix: 'github_pat_', minimumBodyBytes: 20 },
  { prefix: 'ghp_', minimumBodyBytes: 20 },
  { prefix: 'gho_', minimumBodyBytes: 20 },
  { prefix: 'ghu_', minimumBodyBytes: 20 },
  { prefix: 'ghs_', minimumBodyBytes: 20 },
  { prefix: 'ghr_', minimumBodyBytes: 20 },
  { prefix: 'AKIA', minimumBodyBytes: 16 },
  { prefix: 'AIza', minimumBodyBytes: 30 },
  { prefix: 'xoxb-', minimumBodyBytes: 20 },
  { prefix: 'xoxa-', minimumBodyBytes: 20 },
  { prefix: 'xoxp-', minimumBodyBytes: 20 },
  { prefix: 'xoxr-', minimumBodyBytes: 20 },
  { prefix: 'xoxs-', minimumBodyBytes: 20 },
] as const
const STREAM_MAX_PENDING_BYTES = 4096

type PendingSecret = 'bearer' | 'assignment' | 'bare' | 'url'

type IncrementalRedactionState =
  | 'normal'
  | 'candidate'
  | 'assignment-gap'
  | 'assignment-value'
  | 'assignment-scheme-gap'
  | 'assignment-scheme-token'
  | 'bearer-gap'
  | 'bearer-discard'
  | 'bare-token'
  | 'bare-discard'
  | 'url-body'
  | 'url-discard'

function isHighSurrogate(character: string): boolean {
  return (
    character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdbff
  )
}

function isLowSurrogate(character: string): boolean {
  return (
    character.length === 1 && character.charCodeAt(0) >= 0xdc00 && character.charCodeAt(0) <= 0xdfff
  )
}

function isStreamAssignmentBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s,;{[(]/u.test(character)
}

function isStreamBearerBoundary(character: string | undefined): boolean {
  return character === undefined || !/[A-Za-z0-9_]/u.test(character)
}

function isStreamUrlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return code > 0x20 && code !== 0x7f && !/[<>"']/u.test(character)
}

function isStreamAssignmentDelimiter(character: string): boolean {
  return /[\s,;}\])}]/u.test(character)
}

function isStreamBearerDelimiter(character: string): boolean {
  return /[\s,;]/u.test(character)
}

function isStreamBareCharacter(character: string): boolean {
  return /[A-Za-z0-9_-]/u.test(character)
}

function streamCaseInsensitivePrefix(value: string, prefix: string): boolean {
  return prefix.startsWith(value.toLowerCase())
}

function streamCandidateIsPrefix(value: string): boolean {
  return (
    streamCaseInsensitivePrefix(value, STREAM_BEARER_PREFIX) ||
    STREAM_URL_PREFIXES.some((prefix) => streamCaseInsensitivePrefix(value, prefix)) ||
    streamSecretNameIsPrefix(value) ||
    STREAM_BARE_PREFIXES.some(({ prefix }) => prefix.startsWith(value))
  )
}

function streamAssignmentName(value: string): boolean {
  return STREAM_SECRET_NAMES.some((name) => streamSecretNameMatches(value, name, true))
}

function streamSecretNameIsPrefix(value: string): boolean {
  if (value.length === 0) return false
  return STREAM_SECRET_NAMES.some((name) => streamSecretNameMatches(value, name, false))
}

function streamSecretNameMatches(value: string, name: string, complete: boolean): boolean {
  const words = name.split(/[_ -]+/u)
  const lowerValue = value.toLowerCase()
  let offset = 0
  for (const [index, word] of words.entries()) {
    if (offset === lowerValue.length) return !complete || index < words.length
    const remainder = lowerValue.slice(offset)
    if (remainder.length < word.length) return !complete && word.startsWith(remainder)
    if (!remainder.startsWith(word)) return false
    offset += word.length
    if (index === words.length - 1) return offset === lowerValue.length
    while (offset < lowerValue.length && /[_ -]/u.test(lowerValue[offset] ?? '')) offset += 1
  }
  return !complete && offset === lowerValue.length
}

function streamBarePrefix(value: string): (typeof STREAM_BARE_PREFIXES)[number] | undefined {
  return STREAM_BARE_PREFIXES.find(({ prefix }) => prefix === value)
}

function isUrlDelimiter(character: string | undefined): boolean {
  if (character === undefined || /\s/u.test(character)) return true
  const code = character.codePointAt(0) ?? 0
  return code <= 0x20 || code === 0x7f || code === 0x1b || '<>"\''.includes(character)
}

function safeUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
    if (url.pathname.split('/').some((segment) => segment !== '' && isSensitiveName(segment)))
      return false
    for (const key of url.searchParams.keys()) if (isSensitiveName(key)) return false
    const fragment = url.hash.slice(1)
    if (fragment) {
      for (const key of new URLSearchParams(fragment).keys()) if (isSensitiveName(key)) return false
    }
    return true
  } catch {
    return false
  }
}

function isSensitiveName(value: string): boolean {
  const normalized = value.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return (
    normalized.includes('password') ||
    normalized.includes('passphrase') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('authorization') ||
    normalized.includes('credential') ||
    normalized.includes('apikey') ||
    normalized.includes('accesskey') ||
    normalized.includes('privatekey') ||
    normalized.includes('cookie') ||
    normalized.includes('header') ||
    normalized.includes('query') ||
    normalized.includes('fragment') ||
    normalized === 'key' ||
    normalized.endsWith('key')
  )
}

function redactUrls(value: string): string {
  return value.replace(WEB_URL, redactUrl)
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

function redactStable(value: string): string {
  return redactUrls(value)
    .replace(
      SECRET_AUTH_SCHEME_ASSIGNMENT,
      (_match, prefix: string) => `${prefix}[redacted secret]`,
    )
    .replace(BEARER_ASSIGNMENT, '[redacted bearer]')
    .replace(SECRET_ASSIGNMENT, (_match, prefix: string) => `${prefix}[redacted secret]`)
    .replace(BARE_CREDENTIAL, '[redacted credential]')
    .replace(BIDI_CONTROLS, '')
}

function takeUtf8Prefix(value: string, bytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= bytes) return value
  let output = ''
  let used = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > bytes) break
    output += character
    used += size
  }
  return output
}

function splitTail(value: string, bytes: number): [string, string] {
  if (Buffer.byteLength(value, 'utf8') <= bytes) return ['', value]
  const prefix = takeUtf8Prefix(value, Buffer.byteLength(value, 'utf8') - bytes)
  return [prefix, value.slice(prefix.length)]
}

export class SecretTextSanitizer {
  readonly #terminal = new TerminalControlSanitizer()
  readonly #maxOutputBytes: number
  #pending = ''
  #pendingSecret: PendingSecret | undefined
  #outputBytes = 0
  #truncated = false

  constructor(maxOutputBytes = MAX_SANITIZED_TEXT_BYTES) {
    this.#maxOutputBytes = maxOutputBytes
  }

  push(input: string): string {
    this.#pending += this.#terminal.push(input)
    return this.#drain(false)
  }

  finish(): string {
    this.#pending += this.#terminal.finish()
    const result = this.#drain(true)
    if (this.#truncated && this.#outputBytes < this.#maxOutputBytes) {
      const marker = SECRET_TRUNCATION_MARKER
      const boundedMarker = takeUtf8Prefix(marker, this.#maxOutputBytes - this.#outputBytes)
      this.#outputBytes += Buffer.byteLength(boundedMarker, 'utf8')
      return result + boundedMarker
    }
    return result
  }

  #drain(final: boolean): string {
    if (this.#pendingSecret !== undefined) {
      this.#consumePendingSecret(final)
      if (this.#pendingSecret !== undefined) return ''
    }
    if (this.#pending.length === 0) return ''
    const pendingBytes = Buffer.byteLength(this.#pending, 'utf8')
    if (!final && pendingBytes <= MAX_PENDING_BYTES) return ''
    const [stable, tail] = final
      ? [this.#pending, '']
      : splitTail(this.#pending, MAX_LOOKBEHIND_CHARS)
    this.#pending = tail
    if (!stable) return ''
    const incomplete = final ? undefined : incompleteSecret(stable, tail)
    if (incomplete !== undefined) {
      const prefix = stable.slice(0, incomplete.start)
      const boundary = incomplete.boundary
      this.#pendingSecret = incomplete.kind
      this.#pending = tail
      const before = redactStable(prefix + boundary)
      const marker = incomplete.kind === 'bearer' ? '[redacted bearer]' : '[redacted secret]'
      const emitted = this.#append(before + marker)
      this.#consumePendingSecret(final)
      return emitted
    }
    const incompleteCredential = final ? undefined : incompleteBareCredential(stable, tail)
    if (incompleteCredential !== undefined) {
      const prefix = stable.slice(0, incompleteCredential.start)
      const emitted = this.#append(`${redactStable(prefix)}[redacted credential]`)
      this.#pendingSecret = 'bare'
      this.#pending = tail
      this.#consumePendingSecret(final)
      return emitted
    }
    const incompleteUrl = final ? undefined : incompleteUrlAtBoundary(stable, tail)
    if (incompleteUrl !== undefined) {
      const prefix = stable.slice(0, incompleteUrl.start)
      const emitted = this.#append(
        `${redactStable(prefix + incompleteUrl.boundary)}[redacted link]`,
      )
      this.#pendingSecret = 'url'
      this.#pending = tail
      this.#consumePendingSecret(final)
      return emitted
    }
    const redacted = redactStable(stable)
    return this.#append(redacted)
  }

  #append(value: string): string {
    const remaining = this.#maxOutputBytes - this.#outputBytes
    if (remaining <= 0) {
      if (value.length > 0) this.#truncated = true
      return ''
    }
    const bounded = takeUtf8Prefix(value, remaining)
    this.#outputBytes += Buffer.byteLength(bounded, 'utf8')
    if (bounded.length !== value.length) this.#truncated = true
    return bounded
  }

  #consumePendingSecret(final: boolean): void {
    if (this.#pendingSecret === undefined) return
    const value = this.#pending
    if (this.#pendingSecret === 'url') {
      const delimiter = [...value].findIndex(isUrlDelimiter)
      if (delimiter < 0) {
        this.#pending = final ? '' : value.slice(-MAX_LOOKBEHIND_CHARS)
        if (final) this.#pendingSecret = undefined
        return
      }
      this.#pending = value.slice(delimiter)
      this.#pendingSecret = undefined
      return
    }
    if (this.#pendingSecret === 'bare') {
      const delimiter = value.search(/[^A-Za-z0-9_-]/u)
      if (delimiter < 0) {
        this.#pending = final ? '' : value.slice(-MAX_LOOKBEHIND_CHARS)
        if (final) this.#pendingSecret = undefined
        return
      }
      this.#pending = value.slice(delimiter)
      this.#pendingSecret = undefined
      return
    }
    let index = 0
    while (index < value.length && /\s/u.test(value[index] ?? '')) index += 1
    if (index === value.length) {
      this.#pending = final ? '' : value.slice(-MAX_LOOKBEHIND_CHARS)
      if (final) this.#pendingSecret = undefined
      return
    }
    const quoted = value[index] === '"' || value[index] === "'"
    if (quoted) {
      const quote = value[index] ?? ''
      const closing = value.indexOf(quote, index + 1)
      if (closing < 0) {
        this.#pending = final ? '' : value.slice(-MAX_LOOKBEHIND_CHARS)
        if (final) this.#pendingSecret = undefined
        return
      }
      this.#pending = value.slice(closing + 1)
    } else {
      const delimiter = value.slice(index).search(/[\s,;}\])}]/u)
      if (delimiter < 0) {
        this.#pending = final ? '' : value.slice(-MAX_LOOKBEHIND_CHARS)
        if (final) this.#pendingSecret = undefined
        return
      }
      this.#pending = value.slice(index + delimiter)
    }
    this.#pendingSecret = undefined
  }
}

/** Emits safe text promptly while retaining only an active control or credential candidate. */
export class IncrementalSecretTextSanitizer {
  readonly #terminal = new TerminalControlSanitizer()
  readonly #maxOutputBytes: number
  #state: IncrementalRedactionState = 'normal'
  #pending = ''
  #pendingBytes = 0
  #assignmentEligible = false
  #assignmentQuote: string | undefined
  #assignmentValueStarted = false
  #assignmentToken = ''
  #bareMinimumBodyBytes = 0
  #bareBodyBytes = 0
  #outputBytes = 0
  #truncated = false
  #lastCharacter: string | undefined
  #pendingHighSurrogate: string | undefined

  constructor(maxOutputBytes = MAX_SANITIZED_TEXT_BYTES) {
    this.#maxOutputBytes = maxOutputBytes
  }

  push(input: string): string {
    if (typeof input !== 'string' || input.length === 0) return ''
    const normalized = this.#normalizeChunk(input)
    if (normalized.length === 0) return ''
    return this.#consumeVisible(this.#terminal.push(normalized))
  }

  finish(): string {
    const output: string[] = []
    if (this.#pendingHighSurrogate !== undefined) {
      this.#pendingHighSurrogate = undefined
      output.push(this.#consumeVisible(this.#terminal.push('\ufffd')))
    }
    this.#finishRedaction(output)
    this.#terminal.finish()
    if (this.#truncated && this.#outputBytes < this.#maxOutputBytes) {
      this.#append(
        output,
        takeUtf8Prefix(SECRET_TRUNCATION_MARKER, this.#maxOutputBytes - this.#outputBytes),
      )
    }
    return output.join('')
  }

  #normalizeChunk(input: string): string {
    let normalized = ''
    for (const character of input) {
      if (this.#pendingHighSurrogate !== undefined) {
        if (isLowSurrogate(character)) {
          normalized += `${this.#pendingHighSurrogate}${character}`
          this.#pendingHighSurrogate = undefined
          continue
        }
        normalized += '\ufffd'
        this.#pendingHighSurrogate = undefined
      }
      if (isHighSurrogate(character)) this.#pendingHighSurrogate = character
      else normalized += character
    }
    return normalized
  }

  #consumeVisible(input: string): string {
    const output: string[] = []
    for (const character of input) {
      if (BIDI_CHARACTER.test(character)) continue
      this.#consumeCharacter(character, output)
    }
    return output.join('')
  }

  #consumeCharacter(character: string, output: string[]): void {
    for (;;) {
      if (this.#state === 'normal') {
        if (streamCandidateIsPrefix(character)) {
          this.#state = 'candidate'
          this.#pending = character
          this.#pendingBytes = Buffer.byteLength(character, 'utf8')
          this.#assignmentEligible = isStreamAssignmentBoundary(this.#lastCharacter)
          return
        }
        this.#append(output, character)
        this.#lastCharacter = character
        return
      }
      if (this.#state === 'candidate') {
        const isBearerCandidate =
          this.#pending.toLowerCase() === STREAM_BEARER_PREFIX &&
          isStreamBearerBoundary(this.#lastCharacter)
        if (!this.#assignmentEligible && /\s/u.test(character) && !isBearerCandidate) {
          this.#emitLiteral(output, this.#pending)
          this.#clearPending()
          this.#state = 'normal'
          continue
        }
        const candidate = `${this.#pending}${character}`
        if (streamCandidateIsPrefix(candidate)) {
          this.#pending = candidate
          this.#pendingBytes += Buffer.byteLength(character, 'utf8')
          const bare = streamBarePrefix(candidate)
          if (bare !== undefined) {
            this.#state = 'bare-token'
            this.#bareMinimumBodyBytes = bare.minimumBodyBytes
            this.#bareBodyBytes = 0
          } else if (STREAM_URL_PREFIXES.some((prefix) => prefix === candidate.toLowerCase())) {
            this.#state = 'url-body'
          }
          return
        }
        if (this.#assignmentEligible && streamAssignmentName(this.#pending)) {
          if (/\s/u.test(character)) {
            this.#pending += character
            this.#pendingBytes += Buffer.byteLength(character, 'utf8')
            this.#state = 'assignment-gap'
            return
          }
          if (character === ':' || character === '=') {
            this.#beginAssignment(output)
            return
          }
        }
        if (isBearerCandidate) {
          if (/\s|=/u.test(character)) {
            this.#pending += character
            this.#pendingBytes += Buffer.byteLength(character, 'utf8')
            this.#state = 'bearer-gap'
            return
          }
        }
        this.#emitLiteral(output, this.#pending)
        this.#clearPending()
        this.#state = 'normal'
        continue
      }
      if (this.#state === 'assignment-gap') {
        if (/\s/u.test(character)) {
          this.#pending += character
          this.#pendingBytes += Buffer.byteLength(character, 'utf8')
          if (this.#pendingBytes > STREAM_MAX_PENDING_BYTES) this.#beginAssignment(output)
          return
        }
        if (character === ':' || character === '=') {
          this.#beginAssignment(output)
          return
        }
        this.#emitLiteral(output, this.#pending)
        this.#clearPending()
        this.#state = 'normal'
        continue
      }
      if (this.#state === 'assignment-value') {
        if (!this.#assignmentValueStarted) {
          if (/\s/u.test(character)) return
          if (character === '"' || character === "'") {
            this.#assignmentQuote = character
            this.#assignmentValueStarted = true
            return
          }
          if (isStreamAssignmentDelimiter(character)) {
            this.#resetRedactionState()
            continue
          }
          this.#assignmentValueStarted = true
          this.#assignmentToken = character
          return
        }
        if (this.#assignmentQuote !== undefined) {
          if (character === this.#assignmentQuote) this.#resetRedactionState()
          return
        }
        if (
          (character === '=' || /\s/u.test(character)) &&
          (this.#assignmentToken.toLowerCase() === 'bearer' ||
            this.#assignmentToken.toLowerCase() === 'basic')
        ) {
          this.#state = 'assignment-scheme-gap'
          return
        }
        if (isStreamAssignmentDelimiter(character)) {
          this.#resetRedactionState()
          continue
        }
        if (this.#assignmentToken.length < 8) this.#assignmentToken += character
        return
      }
      if (this.#state === 'assignment-scheme-gap') {
        if (/\s/u.test(character) || character === '=') return
        if (isStreamAssignmentDelimiter(character)) {
          this.#resetRedactionState()
          continue
        }
        this.#state = 'assignment-scheme-token'
        return
      }
      if (this.#state === 'assignment-scheme-token') {
        if (isStreamAssignmentDelimiter(character)) {
          this.#resetRedactionState()
          continue
        }
        return
      }
      if (this.#state === 'bearer-gap') {
        if (/\s|=/u.test(character)) {
          this.#pending += character
          this.#pendingBytes += Buffer.byteLength(character, 'utf8')
          if (this.#pendingBytes > STREAM_MAX_PENDING_BYTES) this.#beginBearerDiscard(output)
          return
        }
        if (character === ',' || character === ';') {
          this.#beginBearerDiscard(output)
          this.#resetRedactionState()
          continue
        }
        this.#beginBearerDiscard(output)
        return
      }
      if (this.#state === 'bearer-discard') {
        if (isStreamBearerDelimiter(character)) {
          this.#resetRedactionState()
          continue
        }
        return
      }
      if (this.#state === 'bare-token') {
        if (isStreamBareCharacter(character)) {
          this.#pending += character
          this.#pendingBytes += Buffer.byteLength(character, 'utf8')
          this.#bareBodyBytes += Buffer.byteLength(character, 'utf8')
          if (
            this.#bareBodyBytes >= this.#bareMinimumBodyBytes ||
            this.#pendingBytes > STREAM_MAX_PENDING_BYTES
          )
            this.#beginBareDiscard(output)
          return
        }
        if (this.#bareBodyBytes >= this.#bareMinimumBodyBytes) this.#beginBareDiscard(output)
        else this.#emitLiteral(output, this.#pending)
        this.#clearPending()
        this.#state = 'normal'
        continue
      }
      if (this.#state === 'bare-discard') {
        if (!isStreamBareCharacter(character)) {
          this.#resetRedactionState()
          continue
        }
        return
      }
      if (this.#state === 'url-body') {
        if (isStreamUrlCharacter(character)) {
          this.#pending += character
          this.#pendingBytes += Buffer.byteLength(character, 'utf8')
          if (this.#pendingBytes > STREAM_MAX_PENDING_BYTES) this.#beginUrlDiscard(output)
          return
        }
        const redacted = redactStable(`${redactUrl(this.#pending)}${character}`)
        this.#append(output, redacted)
        this.#clearPending()
        this.#state = 'normal'
        this.#lastCharacter = character
        if (redacted.includes('[redacted bearer]')) this.#state = 'bearer-discard'
        else if (redacted.includes('[redacted secret]')) this.#state = 'assignment-value'
        else if (redacted.includes('[redacted credential]')) this.#state = 'bare-discard'
        return
      }
      if (this.#state === 'url-discard') {
        if (!isStreamUrlCharacter(character)) {
          this.#resetRedactionState()
          continue
        }
        return
      }
      const exhaustive: never = this.#state
      throw new Error(`Unknown incremental redaction state: ${exhaustive}`)
    }
  }

  #beginAssignment(output: string[]): void {
    this.#append(output, '[redacted secret]')
    this.#lastCharacter = ']'
    this.#clearPending()
    this.#state = 'assignment-value'
    this.#assignmentQuote = undefined
    this.#assignmentValueStarted = false
    this.#assignmentToken = ''
  }

  #beginBearerDiscard(output: string[]): void {
    this.#append(output, '[redacted bearer]')
    this.#lastCharacter = ']'
    this.#clearPending()
    this.#state = 'bearer-discard'
  }

  #beginBareDiscard(output: string[]): void {
    this.#append(output, '[redacted credential]')
    this.#lastCharacter = ']'
    this.#clearPending()
    this.#state = 'bare-discard'
  }

  #beginUrlDiscard(output: string[]): void {
    this.#append(output, '[redacted link]')
    this.#lastCharacter = ']'
    this.#clearPending()
    this.#state = 'url-discard'
  }

  #finishRedaction(output: string[]): void {
    switch (this.#state) {
      case 'candidate':
        this.#emitLiteral(output, this.#pending)
        break
      case 'assignment-gap':
        this.#beginAssignment(output)
        break
      case 'assignment-value':
      case 'assignment-scheme-gap':
      case 'assignment-scheme-token':
      case 'bearer-discard':
      case 'bare-discard':
      case 'url-discard':
        break
      case 'bearer-gap':
        this.#beginBearerDiscard(output)
        break
      case 'bare-token':
        if (this.#bareBodyBytes >= this.#bareMinimumBodyBytes) this.#beginBareDiscard(output)
        else this.#emitLiteral(output, this.#pending)
        break
      case 'url-body':
        this.#append(output, redactStable(redactUrl(this.#pending)))
        break
      case 'normal':
        break
      default: {
        const exhaustive: never = this.#state
        throw new Error(`Unknown incremental redaction state: ${exhaustive}`)
      }
    }
    this.#clearPending()
    this.#state = 'normal'
  }

  #emitLiteral(output: string[], value: string): void {
    if (value.length === 0) return
    this.#append(output, value)
    this.#lastCharacter = [...value].at(-1)
  }

  #append(output: string[], value: string): void {
    if (value.length === 0) return
    const remaining = this.#maxOutputBytes - this.#outputBytes
    if (remaining <= 0) {
      this.#truncated = true
      return
    }
    const bounded = takeUtf8Prefix(value, remaining)
    this.#outputBytes += Buffer.byteLength(bounded, 'utf8')
    if (bounded.length !== value.length) this.#truncated = true
    output.push(bounded)
  }

  #clearPending(): void {
    this.#pending = ''
    this.#pendingBytes = 0
    this.#bareMinimumBodyBytes = 0
    this.#bareBodyBytes = 0
  }

  #resetRedactionState(): void {
    this.#clearPending()
    this.#state = 'normal'
    this.#assignmentQuote = undefined
    this.#assignmentValueStarted = false
    this.#assignmentToken = ''
  }
}

function incompleteSecret(
  stable: string,
  tail: string,
): { readonly kind: PendingSecret; readonly start: number; readonly boundary: string } | undefined {
  const bearer = INCOMPLETE_BEARER.exec(stable)
  if (bearer !== null) return { kind: 'bearer', start: bearer.index, boundary: '' }
  const assignment = INCOMPLETE_ASSIGNMENT.exec(stable)
  if (assignment === null || /^[\s,;}\])}]/u.test(tail[0] ?? '')) return undefined
  return {
    kind: 'assignment',
    start: assignment.index,
    boundary: assignment[1] ?? '',
  }
}

function incompleteUrlAtBoundary(
  stable: string,
  tail: string,
): { readonly start: number; readonly boundary: string } | undefined {
  if (isUrlDelimiter(tail[0])) return undefined
  const match = INCOMPLETE_URL.exec(stable)
  if (match === null) return undefined
  return { start: match.index, boundary: match[1] ?? '' }
}

function incompleteBareCredential(
  stable: string,
  tail: string,
): { readonly start: number } | undefined {
  if (!/^[A-Za-z0-9_-]/u.test(tail)) return undefined
  const match = INCOMPLETE_BARE_CREDENTIAL.exec(stable)
  return match === null ? undefined : { start: match.index }
}

export function redactSensitiveText(input: string, maxBytes = MAX_SANITIZED_TEXT_BYTES): string {
  const sanitizer = new SecretTextSanitizer(maxBytes)
  return `${sanitizer.push(input)}${sanitizer.finish()}`
}

export function sanitizeTextChunks(
  chunks: Iterable<string>,
  maxBytes = MAX_SANITIZED_TEXT_BYTES,
): string {
  const sanitizer = new SecretTextSanitizer(maxBytes)
  let output = ''
  for (const chunk of chunks) output += sanitizer.push(chunk)
  return output + sanitizer.finish()
}

export function redactSensitiveUrls(input: string): string {
  return redactUrls(input)
}
