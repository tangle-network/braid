import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

const SENSITIVE_FLAG =
  /(?:auth|api[-_]?key|bearer|credential|password|private[-_]?key|secret|token)/iu
const SECRET_ASSIGNMENT =
  /((?:authorization|cookie|credential|api[-_]?key|password|private[-_]?key|secret|token)\s*[:=]\s*)(["']?)[^\s,;}"']+\2/giu
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu
const URL_USERINFO = /(https?:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/giu
const URL_QUERY_SECRET =
  /([?&](?:authorization|cookie|credential|api[-_]?key|password|private[-_]?key|secret|token)[^=]*=)[^&#\s]+/giu
const ASSIGNMENT_START =
  /(?:authorization|cookie|credential|api[-_]?key|password|private[-_]?key|secret|token)\s*[:=]\s*["']?/giu
const BEARER_START = /\bBearer\s+/giu
const URL_USERINFO_START = /https?:\/\/[^\s/@:]+(?::[^\s/@]*)?/giu
const URL_QUERY_START =
  /[?&](?:authorization|cookie|credential|api[-_]?key|password|private[-_]?key|secret|token)[^=&#\s]*=/giu
const SAFE_ENVIRONMENT_NAMES = new Set([
  'CI',
  'FORCE_COLOR',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'NODE_ENV',
  'TERM',
  'TZ',
])
const MAX_REDACTION_HOLD_CHARS = 1024 * 1024
const SENSITIVE_PREFIX_WINDOW = 256
const MAX_REDACTION_PENDING_CHARS = 1024 * 1024
export const REDACTION_INPUT_CHUNK_CHARS = 64 * 1024

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function boundedText(value, maximum = 512) {
  const text = String(value)
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function secretPattern(secret) {
  return new RegExp(escapeRegExp(secret), 'gu')
}

function matches(pattern, text) {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))]
}

function longestSecretPrefixSuffix(text, secret) {
  const prefixTable = new Array(secret.length).fill(0)
  for (let index = 1, length = 0; index < secret.length; index += 1) {
    while (length > 0 && secret[index] !== secret[length]) length = prefixTable[length - 1]
    if (secret[index] === secret[length]) length += 1
    prefixTable[index] = length
  }
  let length = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    while (length > 0 && character !== secret[length]) length = prefixTable[length - 1]
    if (character === secret[length]) length += 1
    if (length === secret.length) length = prefixTable[length - 1]
  }
  return length
}

function safeRedactionBoundary(text, desired, secrets) {
  let boundary = Math.max(0, desired - SENSITIVE_PREFIX_WINDOW)
  const fullPatterns = [SECRET_ASSIGNMENT, BEARER, URL_USERINFO, URL_QUERY_SECRET]
  const startPatterns = [ASSIGNMENT_START, BEARER_START, URL_USERINFO_START, URL_QUERY_START]
  const fullMatches = fullPatterns.map((pattern) => matches(pattern, text))
  const startMatches = startPatterns.map((pattern) => matches(pattern, text))
  for (let pass = 0; pass < 8; pass += 1) {
    const previous = boundary
    for (const secretValue of secrets) {
      const secret = String(secretValue)
      if (secret.length === 0) continue
      for (
        let index = text.indexOf(secret);
        index !== -1;
        index = text.indexOf(secret, index + 1)
      ) {
        if (index < boundary && index + secret.length > boundary) boundary = index
      }
      const suffixLength = longestSecretPrefixSuffix(text, secret)
      const suffixStart = text.length - suffixLength
      if (suffixLength > 0 && suffixStart < boundary) boundary = suffixStart
    }
    for (let index = 0; index < fullMatches.length; index += 1) {
      for (const match of fullMatches[index]) {
        const start = match.index ?? 0
        if (start < boundary && start + match[0].length > boundary) boundary = start
      }
      for (const match of startMatches[index]) {
        const start = match.index ?? 0
        if (start >= boundary) continue
        const complete = fullMatches[index].find((candidate) => (candidate.index ?? 0) === start)
        if (!complete || start + complete[0].length > boundary) boundary = start
      }
    }
    if (boundary === previous) return boundary
  }
  return boundary
}

export function redactText(value, secrets = []) {
  let redacted = String(value)
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(URL_QUERY_SECRET, '$1[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1$2[REDACTED]$2')
  for (const secret of [...new Set(secrets)].filter((candidate) => String(candidate).length > 0)) {
    redacted = redacted.replace(secretPattern(String(secret)), '[REDACTED]')
  }
  return redacted
}

export function sanitizeArgv(argv, secrets = []) {
  assert(Array.isArray(argv) && argv.length > 0, 'Command argv must be non-empty')
  let redactNext = false
  return argv.map((value, index) => {
    const argument = String(value)
    const flag = index > 0 && SENSITIVE_FLAG.test(argument)
    if (redactNext) {
      redactNext = false
      return '[REDACTED]'
    }
    if (flag && index + 1 < argv.length) {
      redactNext = true
      return redactText(argument, secrets)
    }
    return boundedText(redactText(argument, secrets))
  })
}

function isProvablySafeEnvironmentValue(name, value) {
  const text = String(value)
  if (name === 'CI' || name === 'FORCE_COLOR' || name === 'NO_COLOR')
    return /^(?:0|1|true|false)?$/iu.test(text)
  if (name === 'NODE_ENV') return /^(?:development|production|test)$/u.test(text)
  if (name === 'LANG' || name === 'LC_ALL')
    return /^[A-Za-z]{2,12}(?:[_-][A-Za-z0-9]{2,12})?(?:\.[A-Za-z0-9_-]+)?$/u.test(text)
  if (name === 'TERM') return /^[A-Za-z0-9._-]{1,64}$/u.test(text)
  if (name === 'TZ') return /^[A-Za-z0-9_+./-]{1,64}$/u.test(text)
  return false
}

const CREDENTIAL_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|BEARER|COOKIE|CREDENTIAL|PASS(?:WORD|WD)?|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(?:_|$)/iu

/** Returns only values whose names identify credentials, plus caller-supplied canaries. */
export function collectCredentialSecrets(environment, explicitSecrets = []) {
  const credentialValues = Object.entries(environment ?? {})
    .filter(([name]) => CREDENTIAL_ENVIRONMENT_NAME.test(name))
    .map(([, value]) => value)
  return [
    ...new Set(
      [...explicitSecrets, ...credentialValues]
        .map((value) => String(value))
        .filter((value) => value.length > 0),
    ),
  ]
}

export function collectRedactionSecrets(environment, explicitSecrets = []) {
  const environmentValues = Object.entries(environment ?? {})
    .filter(([name, value]) => !isProvablySafeEnvironmentValue(name, value))
    .map(([, value]) => value)
  return [
    ...new Set(
      [...explicitSecrets, ...environmentValues]
        .map((value) => String(value))
        .filter((value) => value.length > 0),
    ),
  ]
}

function safeEnvironmentValue(name, value) {
  return SAFE_ENVIRONMENT_NAMES.has(name) && isProvablySafeEnvironmentValue(name, value)
    ? boundedText(redactText(value))
    : '[REDACTED]'
}

export function sanitizeEnvironment(environment, maximumEntries = 512) {
  const entries = Object.entries(environment ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  const variables = entries.slice(0, maximumEntries).map(([name, value]) => ({
    name,
    value: safeEnvironmentValue(name, value),
    byteLength: Buffer.byteLength(String(value)),
  }))
  return {
    variables,
    omittedCount: Math.max(0, entries.length - variables.length),
  }
}

function validUtf8Prefix(bytes, maximum) {
  let end = Math.min(bytes.length, maximum)
  if (end === bytes.length) return bytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  if (end > 0) {
    let start = end - 1
    while (start > 0 && (bytes[start] & 0xc0) === 0x80) start -= 1
    const lead = bytes[start]
    const expected = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2
    if (expected > end - start) end = start
  }
  return bytes.subarray(0, end)
}

export class BoundedCapture {
  #rawByteLength = 0
  #redactedChunks = []
  #redactedBytes = 0
  #maximum
  #redactor
  #finished = false
  #redactedTruncated = false

  constructor(maximum, secrets = []) {
    assert(Number.isInteger(maximum) && maximum > 0, 'Maximum log bytes must be positive')
    this.#maximum = maximum
    this.#redactor = new StreamingRedactor(secrets, (text) => this.#retain(text))
  }

  #retain(text) {
    if (text.length === 0) return
    const bytes = Buffer.from(text.normalize('NFC'))
    if (this.#redactedBytes >= this.#maximum) {
      this.#redactedTruncated = true
      return
    }
    const remaining = this.#maximum - this.#redactedBytes
    const retained = validUtf8Prefix(bytes, remaining)
    this.#redactedChunks.push(retained)
    this.#redactedBytes += retained.length
    if (retained.length < bytes.length) this.#redactedTruncated = true
  }

  push(chunk) {
    assert(!this.#finished, 'Cannot append to a finished output capture')
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    this.#rawByteLength += bytes.length
    this.#redactor.push(bytes)
  }

  finish() {
    assert(!this.#finished, 'Output capture was finished twice')
    this.#finished = true
    this.#redactor.finish()
    const redacted = Buffer.concat(this.#redactedChunks)
    this.#redactedChunks = []
    return Object.freeze({
      bytes: redacted,
      rawByteLength: this.#rawByteLength,
      redactedSha256: createHash('sha256').update(redacted).digest('hex'),
      redactedByteLength: redacted.length,
      redactedTruncated: this.#redactedTruncated,
      redactionFailClosed: this.#redactor.redactionFailClosed,
    })
  }
}

class StreamingRedactor {
  #decoder = new StringDecoder('utf8')
  #pending = ''
  #secrets
  #holdChars
  #emit
  #redactionFailClosed = false

  constructor(secrets, emit) {
    this.#secrets = [...new Set(secrets.map((secret) => String(secret)).filter(Boolean))].sort(
      (left, right) => right.length - left.length,
    )
    this.#holdChars = Math.min(
      MAX_REDACTION_HOLD_CHARS,
      Math.max(256, ...this.#secrets.map((secret) => secret.length + 256)),
    )
    this.#emit = emit
  }

  push(bytes) {
    const text = this.#decoder.write(bytes)
    for (let offset = 0; offset < text.length; offset += REDACTION_INPUT_CHUNK_CHARS)
      this.#consume(text.slice(offset, offset + REDACTION_INPUT_CHUNK_CHARS), false)
  }

  finish() {
    this.#consume(this.#decoder.end(), false)
    this.#consume('', true)
    this.#pending = ''
    this.#secrets = []
  }

  get redactionFailClosed() {
    return this.#redactionFailClosed
  }

  #consume(text, final) {
    if (this.#redactionFailClosed) return
    const combined = `${this.#pending}${text}`
    const splitAt = final
      ? combined.length
      : safeRedactionBoundary(
          combined,
          Math.max(0, combined.length - this.#holdChars),
          this.#secrets,
        )
    if (!final && combined.length - splitAt > MAX_REDACTION_PENDING_CHARS) {
      if (splitAt > 0) this.#emit(redactText(combined.slice(0, splitAt), this.#secrets))
      this.#emit('[REDACTED]')
      this.#pending = ''
      this.#redactionFailClosed = true
      return
    }
    this.#emit(redactText(combined.slice(0, splitAt), this.#secrets))
    this.#pending = combined.slice(splitAt)
  }
}
