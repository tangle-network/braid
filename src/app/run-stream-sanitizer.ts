import { IncrementalSecretTextSanitizer } from '../domain/secret-sanitizer.js'

/** Bounds the number of provider streams that one application retains. */
export const MAX_ACTIVE_RUNTIME_STREAMS = 256

/** A stream name is application-owned and never contains provider payload data. */
export type RuntimeStreamName = 'text' | 'reasoning' | 'final' | `part:${string}`

export interface RuntimeStreamSanitizer {
  readonly push: (runId: string, stream: RuntimeStreamName, text: string) => string
  readonly complete: (runId: string, stream: RuntimeStreamName, text: string) => string
  readonly finish: (runId: string, stream: RuntimeStreamName) => string
  readonly reset: (runId: string) => void
}

interface ActiveStream {
  readonly sanitizer: IncrementalSecretTextSanitizer
  finished: boolean
}

/** Owns incremental provider text state at the application ingestion boundary. */
export class ApplicationStreamSanitizer implements RuntimeStreamSanitizer {
  readonly #streams = new Map<string, Map<RuntimeStreamName, ActiveStream>>()
  readonly #maxActiveStreams: number
  #activeStreams = 0

  constructor(maxActiveStreams = MAX_ACTIVE_RUNTIME_STREAMS) {
    if (!Number.isSafeInteger(maxActiveStreams) || maxActiveStreams < 1)
      throw new RangeError('maxActiveStreams must be a positive safe integer')
    this.#maxActiveStreams = maxActiveStreams
  }

  push(runId: string, stream: RuntimeStreamName, text: string): string {
    if (typeof text !== 'string' || text.length === 0) return ''
    const active = this.#getOrCreate(runId, stream)
    if (active === undefined || active.finished) return ''
    return active.sanitizer.push(text)
  }

  complete(runId: string, stream: RuntimeStreamName, text: string): string {
    if (typeof text !== 'string') return this.finish(runId, stream)
    const active = this.#getOrCreate(runId, stream)
    if (active === undefined) return ''
    if (active.finished) return ''
    const output = `${active.sanitizer.push(text)}${active.sanitizer.finish()}`
    active.finished = true
    return output
  }

  finish(runId: string, stream: RuntimeStreamName): string {
    const active = this.#streams.get(runId)?.get(stream)
    if (active === undefined) return ''
    if (active.finished) return ''
    active.finished = true
    return active.sanitizer.finish()
  }

  reset(runId: string): void {
    const streams = this.#streams.get(runId)
    if (streams === undefined) return
    this.#activeStreams -= streams.size
    this.#streams.delete(runId)
  }

  get activeStreamCount(): number {
    return this.#activeStreams
  }

  #getOrCreate(runId: string, stream: RuntimeStreamName): ActiveStream | undefined {
    let streams = this.#streams.get(runId)
    const existing = streams?.get(stream)
    if (existing !== undefined) return existing
    if (this.#activeStreams >= this.#maxActiveStreams) return undefined
    if (streams === undefined) {
      streams = new Map()
      this.#streams.set(runId, streams)
    }
    const active = {
      sanitizer: new IncrementalSecretTextSanitizer(Number.POSITIVE_INFINITY),
      finished: false,
    }
    streams.set(stream, active)
    this.#activeStreams += 1
    return active
  }
}
