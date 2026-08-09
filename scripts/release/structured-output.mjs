const RESULT_PREFIX = Buffer.from('BRAID_RELEASE_RESULT_JSON=')
const MEASUREMENTS_PREFIX = Buffer.from('BRAID_RELEASE_MEASUREMENTS_JSON=')
const PREFIXES = [RESULT_PREFIX, MEASUREMENTS_PREFIX]
const MAX_MARKER_LINE_BYTES = 1024 * 1024
const MAX_MARKER_BYTES = 2 * MAX_MARKER_LINE_BYTES

function startsWithPrefix(line) {
  return PREFIXES.some(
    (prefix) => line.length >= prefix.length && line.subarray(0, prefix.length).equals(prefix),
  )
}

/** Keeps only bounded machine-result lines; ordinary stdout remains in the redacted log path. */
export class StructuredOutputCapture {
  #pending = Buffer.alloc(0)
  #markers = []
  #markerBytes = 0
  #discardingLine = false
  #error = null
  #finished = false

  #retainLine(line) {
    if (!startsWithPrefix(line)) return
    if (line.length > MAX_MARKER_LINE_BYTES || this.#markerBytes + line.length > MAX_MARKER_BYTES) {
      this.#error = 'Structured release output exceeded its bounded size'
      return
    }
    this.#markers.push(line)
    this.#markerBytes += line.length
  }

  push(chunk) {
    if (this.#finished) throw new Error('Cannot append to finished structured output')
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    while (bytes.length > 0) {
      if (this.#discardingLine) {
        const newline = bytes.indexOf(0x0a)
        if (newline === -1) return
        this.#discardingLine = false
        bytes = bytes.subarray(newline + 1)
        continue
      }
      const newline = bytes.indexOf(0x0a)
      if (newline === -1) {
        this.#pending = Buffer.concat([this.#pending, bytes])
        if (this.#pending.length > MAX_MARKER_LINE_BYTES) {
          if (startsWithPrefix(this.#pending))
            this.#error = 'Structured release output contained an oversized line'
          this.#pending = Buffer.alloc(0)
          this.#discardingLine = true
        }
        return
      }
      const line = Buffer.concat([this.#pending, bytes.subarray(0, newline + 1)])
      this.#pending = Buffer.alloc(0)
      this.#retainLine(line)
      bytes = bytes.subarray(newline + 1)
    }
  }

  finish() {
    if (this.#finished) throw new Error('Structured output was finished twice')
    this.#finished = true
    if (!this.#discardingLine && this.#pending.length > 0) this.#retainLine(this.#pending)
    this.#pending = Buffer.alloc(0)
    const bytes = Buffer.concat(this.#markers)
    this.#markers = []
    return Object.freeze({ bytes, error: this.#error })
  }
}
