import {
  IncrementalSecretTextSanitizer,
  MAX_SANITIZED_TEXT_BYTES,
} from '../domain/secret-sanitizer.js'

export const MAX_RUNTIME_STREAM_TEXT_BYTES = MAX_SANITIZED_TEXT_BYTES
export const MAX_ACTIVE_RUNTIME_STREAMS = 256

interface ActiveRuntimeStream {
  readonly sanitizer: IncrementalSecretTextSanitizer
  sequence: number
  accumulatedText: string
}

export interface RuntimeStreamCompletion {
  readonly pendingText: string
  readonly accumulatedText: string
}

function utf8Prefix(value: string, bytes: number): string {
  if (bytes <= 0) return ''
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

function appendBounded(current: string, value: string): string {
  const remaining = MAX_RUNTIME_STREAM_TEXT_BYTES - Buffer.byteLength(current, 'utf8')
  return `${current}${utf8Prefix(value, remaining)}`
}

/** Keeps provider text state per run without allowing pending data to grow unbounded. */
export class RuntimeStreamBudget {
  readonly #streams = new Map<string, ActiveRuntimeStream>()

  push(runId: string, sequence: number, text: string): string {
    if (text.length === 0) return ''
    if (sequence === 1) this.#streams.delete(runId)
    let stream = this.#streams.get(runId)
    if (stream === undefined) {
      if (this.#streams.size >= MAX_ACTIVE_RUNTIME_STREAMS) return ''
      stream = {
        sanitizer: new IncrementalSecretTextSanitizer(MAX_RUNTIME_STREAM_TEXT_BYTES),
        sequence,
        accumulatedText: '',
      }
      this.#streams.set(runId, stream)
    } else if (sequence <= stream.sequence) {
      return ''
    } else {
      stream.sequence = sequence
    }
    const emitted = stream.sanitizer.push(text)
    stream.accumulatedText = appendBounded(stream.accumulatedText, emitted)
    return emitted
  }

  finish(runId: string): RuntimeStreamCompletion {
    const stream = this.#streams.get(runId)
    if (stream === undefined) return { pendingText: '', accumulatedText: '' }
    this.#streams.delete(runId)
    const pendingText = stream.sanitizer.finish()
    return {
      pendingText,
      accumulatedText: appendBounded(stream.accumulatedText, pendingText),
    }
  }

  discard(runId: string): void {
    this.#streams.delete(runId)
  }
}

const runtimeStreamBudget = new RuntimeStreamBudget()

export function sanitizeRuntimeTextDelta(runId: string, sequence: number, text: string): string {
  return runtimeStreamBudget.push(runId, sequence, text)
}

export function finishRuntimeStream(runId: string): RuntimeStreamCompletion {
  return runtimeStreamBudget.finish(runId)
}

export function discardRuntimeText(runId: string): void {
  runtimeStreamBudget.discard(runId)
}
