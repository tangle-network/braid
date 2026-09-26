import { TerminalControlSanitizer } from './terminal-sanitizer.js'

export const MAX_SANITIZED_TEXT_BYTES = 512 * 1024
export const SECRET_TRUNCATION_MARKER = '… [truncated]'
const MAX_PENDING_BYTES = 4096
const MAX_LOOKBEHIND_CHARS = 1024
const BIDI_CONTROLS = /\p{Bidi_Control}/gu
// A secret name may sit inside JSON quotes (escaped or not) and may carry an
// identifier prefix such as TANGLE_API_KEY or X-Api-Key; the value may be quoted.
const SECRET_NAME_SOURCE = String.raw`(?:\\?["'])?(?:[A-Za-z0-9]+[_.-])*(?:password|passwd|passphrase|token|secret|credential|authorization|auth|key|api[_ -]*key|access[_ -]*key|private[_ -]*key|client[_ -]*secret|signature|cookie|header|query|fragment)(?:\\?["'])?`
const SECRET_BOUNDARY_SOURCE = String.raw`(^|[\s,;{[(])`
const SECRET_VALUE_SOURCE = String.raw`(?:\\?"(?:\\.|[^"\\])*\\?"|'(?:\\.|[^'\\])*'|[^\s,;}\])}"']*)`
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`${SECRET_BOUNDARY_SOURCE}${SECRET_NAME_SOURCE}\s*[:=]\s*${SECRET_VALUE_SOURCE}`,
  'giu',
)
const SECRET_AUTH_SCHEME_ASSIGNMENT = new RegExp(
  String.raw`${SECRET_BOUNDARY_SOURCE}${SECRET_NAME_SOURCE}\s*[:=]\s*(?:\\?["'])?(?:Bearer|Basic)(?:\s+|\s*=\s*)[^\s,;}\])}"']+`,
  'giu',
)
const BEARER_ASSIGNMENT = /\bBearer(?:\s+|\s*=\s*)[^\s,;]*/giu
const BARE_CREDENTIAL =
  /(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})/gu
const WEB_URL = /https?:\/\/[^\s\p{Cc}<>"']+/giu
const INCOMPLETE_BEARER = /\bBearer(?:[\s]+|[\s]*=[\s]*)([^\s,;]*)$/iu
const INCOMPLETE_URL = /(^|[\s([{<])https?:\/\/[^\s\p{Cc}<>"']*$/iu
const INCOMPLETE_ASSIGNMENT = new RegExp(
  String.raw`${SECRET_BOUNDARY_SOURCE}${SECRET_NAME_SOURCE}\s*[:=]\s*((?:\\?"(?:\\.|[^"\\])*\\?|'(?:\\.|[^'\\])*\\?|[^\s,;}\])}"']*))$`,
  'iu',
)

const INCOMPLETE_BARE_CREDENTIAL =
  /(?:sk-|github_pat_|gh[pousr]_|AKIA|AIza|xox[baprs]-)[A-Za-z0-9_-]*$/u

const STREAM_MAX_PENDING_BYTES = 4096

type PendingSecretKind = 'bearer' | 'assignment' | 'bare' | 'url'
interface PendingSecret {
  readonly kind: PendingSecretKind
  readonly quote?: string
  readonly escapedQuote?: boolean
  readonly valueStarted?: boolean
  readonly escapeCount?: number
}

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

  /** Push text that ends on a line boundary and release everything that is complete. */
  flushLines(input: string): string {
    this.#pending += this.#terminal.push(input)
    if (this.#pendingSecret !== undefined) return this.#drain(false)
    const redacted = this.#append(redactStable(this.#pending))
    this.#pending = ''
    return redacted
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
      this.#pendingSecret = incomplete
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
      this.#pendingSecret = { kind: 'bare' }
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
      this.#pendingSecret = { kind: 'url' }
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
    if (this.#pendingSecret.kind === 'url') {
      let delimiter = 0
      for (const character of value) {
        if (isUrlDelimiter(character)) break
        delimiter += character.length
      }
      if (delimiter === value.length) {
        this.#pending = ''
        if (final) this.#pendingSecret = undefined
        return
      }
      this.#pending = value.slice(delimiter)
      this.#pendingSecret = undefined
      return
    }
    if (this.#pendingSecret.kind === 'bare') {
      const delimiter = value.search(/[^A-Za-z0-9_-]/u)
      if (delimiter < 0) {
        this.#pending = ''
        if (final) this.#pendingSecret = undefined
        return
      }
      this.#pending = value.slice(delimiter)
      this.#pendingSecret = undefined
      return
    }
    const pending = this.#pendingSecret
    let index = 0
    if (pending.valueStarted !== true)
      while (index < value.length && /\s/u.test(value[index] ?? '')) index += 1
    if (index === value.length) {
      this.#pending = ''
      if (final) this.#pendingSecret = undefined
      return
    }
    if (pending.quote !== undefined) {
      let escapeCount = pending.escapeCount ?? 0
      let closing = -1
      for (; index < value.length; index += 1) {
        const character = value[index]
        if (
          character === pending.quote &&
          (pending.escapedQuote === true ? escapeCount % 4 === 1 : escapeCount % 2 === 0)
        ) {
          closing = index
          break
        }
        escapeCount = character === '\\' ? (escapeCount + 1) % 4 : 0
      }
      if (closing < 0) {
        this.#pending = ''
        this.#pendingSecret = final ? undefined : { ...pending, escapeCount }
        return
      }
      this.#pending = value.slice(closing + 1)
    } else {
      const delimiter = value.slice(index).search(/[\s,;}\])}]/u)
      if (delimiter < 0) {
        this.#pending = ''
        this.#pendingSecret = final ? undefined : { ...pending, valueStarted: true }
        return
      }
      this.#pending = value.slice(index + delimiter)
    }
    this.#pendingSecret = undefined
  }
}

/**
 * Streams sanitized text a complete line at a time. Each emitted line goes
 * through the same recognizer as batch redaction, so a chunk boundary can never
 * split a secret name from its value. A line longer than the pending bound is
 * released through the batch sanitizer, which withholds any incomplete secret.
 */
export class IncrementalSecretTextSanitizer {
  readonly #lines: SecretTextSanitizer
  #pending = ''
  #pendingHighSurrogate: string | undefined

  constructor(maxOutputBytes = MAX_SANITIZED_TEXT_BYTES) {
    this.#lines = new SecretTextSanitizer(maxOutputBytes)
  }

  push(input: string): string {
    if (typeof input !== 'string' || input.length === 0) return ''
    this.#pending += this.#normalizeChunk(input)
    const lineEnd = this.#pending.lastIndexOf('\n')
    if (lineEnd < 0) {
      if (Buffer.byteLength(this.#pending, 'utf8') <= STREAM_MAX_PENDING_BYTES) return ''
      const overflow = this.#pending
      this.#pending = ''
      return this.#lines.push(overflow)
    }
    const complete = this.#pending.slice(0, lineEnd + 1)
    this.#pending = this.#pending.slice(lineEnd + 1)
    return this.#lines.flushLines(complete)
  }

  finish(): string {
    if (this.#pendingHighSurrogate !== undefined) {
      this.#pendingHighSurrogate = undefined
      this.#pending += '\ufffd'
    }
    const rest = this.#pending
    this.#pending = ''
    return this.#lines.push(rest) + this.#lines.finish()
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
}

function trailingBackslashes(value: string): number {
  let count = 0
  for (let index = value.length - 1; index >= 0 && value[index] === '\\'; index -= 1) count += 1
  return count % 4
}

function incompleteSecret(
  stable: string,
  tail: string,
): (PendingSecret & { readonly start: number; readonly boundary: string }) | undefined {
  const bearer = INCOMPLETE_BEARER.exec(stable)
  if (bearer !== null && !/^[\s,;]/u.test(tail))
    return {
      kind: 'bearer',
      start: bearer.index,
      boundary: '',
      valueStarted: (bearer[1]?.length ?? 0) > 0,
    }
  const assignment = INCOMPLETE_ASSIGNMENT.exec(stable)
  if (assignment === null) return undefined
  const value = assignment[2] ?? ''
  const escapedQuote = value.startsWith('\\"')
  const quote = escapedQuote ? '"' : ['"', "'"].includes(value[0] ?? '') ? value[0] : undefined
  if (quote === undefined && /^[\s,;}\])}]/u.test(tail[0] ?? '')) return undefined
  return {
    kind: 'assignment',
    ...(quote === undefined
      ? {}
      : { quote, escapedQuote, escapeCount: trailingBackslashes(value) }),
    valueStarted: value.length > 0,
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
