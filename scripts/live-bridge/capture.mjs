import { redactString } from './redaction.mjs'

const defaultHoldChars = 512
const maxPendingChars = 8_192
const sensitiveBoundaryPattern =
  /(?:bearer\s+[A-Za-z0-9._~+/=-]*|(?:token|access[-_]?token|refresh[-_]?token|api[-_]?key|secret|client[-_]?secret|password|authorization|credential)\s*[:=]\s*[^,\s;&#]*|https?:\/\/[^/\s@]*|\b(?:sk|pk|rk)-[A-Za-z0-9_-]*|\bgh[pousr]_[A-Za-z0-9_]*)$/iu
const sensitiveMarkers = Object.freeze([
  'http://',
  'https://',
  'bearer',
  'token=',
  'token:',
  'access_token=',
  'access-token=',
  'access_token:',
  'access-token:',
  'refresh_token=',
  'refresh-token=',
  'api_key=',
  'api-key=',
  'secret=',
  'secret:',
  'password=',
  'password:',
  'authorization=',
  'authorization:',
  'credential=',
  'credential:',
  'sk-',
  'pk-',
  'rk-',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
])

export function appendBounded(current, chunk, maxBytes = 256_000) {
  const next = Buffer.from(`${current}${chunk}`, 'utf8')
  if (next.byteLength <= maxBytes) return next.toString('utf8')
  if (maxBytes <= 0) return ''
  let start = next.byteLength - maxBytes
  while (start < next.byteLength && (next[start] & 0xc0) === 0x80) start += 1
  return next.subarray(start).toString('utf8')
}

function sensitiveStartAtBoundary(value, boundary) {
  const prefix = value.slice(0, boundary)
  const match = prefix.match(sensitiveBoundaryPattern)
  if (match?.index !== undefined) return match.index
  const lowerPrefix = prefix.toLowerCase()
  for (const marker of sensitiveMarkers) {
    for (let length = 1; length < marker.length; length += 1) {
      if (lowerPrefix.endsWith(marker.slice(0, length))) return boundary - length
    }
  }
  return undefined
}

export class StreamingRedactor {
  constructor(maxBytes = 256_000, holdChars = defaultHoldChars) {
    this.maxBytes = maxBytes
    this.holdChars = holdChars
    this.pending = ''
    this.retained = ''
    this.finished = false
  }

  push(chunk) {
    if (this.finished) return this.retained
    const value = `${this.pending}${chunk}`
    if (value.length <= this.holdChars) {
      this.pending = value
      return this.retained
    }
    let boundary = value.length - this.holdChars
    const sensitiveStart = sensitiveStartAtBoundary(value, boundary)
    if (sensitiveStart !== undefined) boundary = sensitiveStart
    if (value.length - boundary > maxPendingChars) {
      this.retained = appendBounded(this.retained, '[redacted-stream-overflow]', this.maxBytes)
      this.pending = ''
      return this.retained
    }
    this.retained = appendBounded(
      this.retained,
      redactString(value.slice(0, boundary)),
      this.maxBytes,
    )
    this.pending = value.slice(boundary)
    return this.retained
  }

  snapshot() {
    return this.retained
  }

  finish() {
    if (this.finished) return this.retained
    this.retained = appendBounded(this.retained, redactString(this.pending), this.maxBytes)
    this.pending = ''
    this.finished = true
    return this.retained
  }
}
