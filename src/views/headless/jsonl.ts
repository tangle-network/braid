import { AppError } from '../../app/application.js'
import { AnalysisLimitError, boundedCloneAndFreeze } from '../../analysis/bounded-copy.js'

export const RPC_MAX_LINE_BYTES = 1_048_576
export const RPC_MAX_INPUT_BYTES = 16 * 1024 * 1024
export const RPC_MAX_JSON_DEPTH = 64
export const RPC_MAX_QUEUE_BYTES = 16 * 1024 * 1024
const utf8 = new TextEncoder()

export interface RpcInput extends AsyncIterable<string | Uint8Array> {}

export interface RpcOutput {
  write(chunk: string): boolean
  once?: (event: 'drain', listener: () => void) => unknown
  waitForDrain?: () => Promise<void>
}

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new AppError('INVALID_UTF8', 'Input contains invalid UTF-8')
  }
}

/** Stream bytes into bounded lines; no complete line is allocated before its byte limit is known. */
export async function* linesOf(input: RpcInput): AsyncGenerator<string> {
  let totalBytes = 0
  let lineBytes = 0
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  for await (const rawChunk of input) {
    const chunkBytes =
      typeof rawChunk === 'string' ? Buffer.byteLength(rawChunk, 'utf8') : rawChunk.byteLength
    totalBytes += chunkBytes
    if (totalBytes > RPC_MAX_INPUT_BYTES)
      throw new AppError('INPUT_LIMIT', 'JSONL input exceeds its byte limit')
    if (typeof rawChunk === 'string') {
      let segmentStart = 0
      let position = 0
      let segmentBytes = 0
      for (const character of rawChunk) {
        const characterBytes = Buffer.byteLength(character, 'utf8')
        if (character === '\n') {
          lineBytes += segmentBytes
          if (lineBytes > RPC_MAX_LINE_BYTES)
            throw new AppError('INPUT_LIMIT', 'JSONL line exceeds its byte limit')
          const part = utf8.encode(rawChunk.slice(segmentStart, position))
          if (part.byteLength > 0) {
            pending.push(part)
            pendingBytes += part.byteLength
          }
          const line = decode(concatChunks(pending, pendingBytes))
          if (line.length > 0) yield line
          pending = []
          pendingBytes = 0
          lineBytes = 0
          segmentStart = position + character.length
          segmentBytes = 0
        } else {
          segmentBytes += characterBytes
        }
        position += character.length
      }
      lineBytes += segmentBytes
      if (lineBytes > RPC_MAX_LINE_BYTES)
        throw new AppError('INPUT_LIMIT', 'JSONL line exceeds its byte limit')
      const tail = utf8.encode(rawChunk.slice(segmentStart))
      if (tail.byteLength > 0) {
        pending.push(tail)
        pendingBytes += tail.byteLength
      }
      continue
    }
    const chunk = rawChunk
    let start = 0
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue
      lineBytes += index - start
      if (lineBytes > RPC_MAX_LINE_BYTES)
        throw new AppError('INPUT_LIMIT', 'JSONL line exceeds its byte limit')
      const part = chunk.slice(start, index)
      if (part.byteLength > 0) {
        pending.push(part)
        pendingBytes += part.byteLength
      }
      const line = decode(concatChunks(pending, pendingBytes))
      if (line.length > 0) yield line
      pending = []
      pendingBytes = 0
      lineBytes = 0
      start = index + 1
    }
    lineBytes += chunk.length - start
    if (lineBytes > RPC_MAX_LINE_BYTES)
      throw new AppError('INPUT_LIMIT', 'JSONL line exceeds its byte limit')
    const tail = chunk.slice(start)
    if (tail.byteLength > 0) {
      pending.push(tail)
      pendingBytes += tail.byteLength
    }
  }
  if (pendingBytes > 0) yield decode(concatChunks(pending, pendingBytes))
}

export function assertJsonDepth(line: string): void {
  let depth = 0
  let quoted = false
  let escaped = false
  for (const character of line) {
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      continue
    }
    if (character === '{' || character === '[') {
      depth += 1
      if (depth > RPC_MAX_JSON_DEPTH)
        throw new AppError('JSON_DEPTH_LIMIT', 'JSON nesting is too deep')
    } else if (character === '}' || character === ']') {
      depth -= 1
      if (depth < 0) throw new AppError('MALFORMED_JSON', 'JSON delimiters are unbalanced')
    }
  }
  if (quoted || escaped || depth !== 0)
    throw new AppError('MALFORMED_JSON', 'Input is not valid JSON')
}

export function parseJsonLine(line: string): unknown {
  assertJsonDepth(line)
  try {
    return boundedCloneAndFreeze(JSON.parse(line))
  } catch (error) {
    if (error instanceof AnalysisLimitError) throw new AppError('INPUT_LIMIT', error.message)
    if (error instanceof AppError) throw error
    throw new AppError('MALFORMED_JSON', 'Input is not valid JSON')
  }
}

export class RpcOutputQueue {
  #pendingBytes = 0
  #tail = Promise.resolve()

  constructor(private readonly output: RpcOutput) {}

  enqueue(line: string): void {
    this.#pendingBytes += Buffer.byteLength(line, 'utf8')
    if (this.#pendingBytes > RPC_MAX_QUEUE_BYTES)
      throw new AppError('OUTPUT_LIMIT', 'JSONL output queue exceeds its byte limit')
    this.#tail = this.#tail.then(async () => {
      const bytes = Buffer.byteLength(line, 'utf8')
      try {
        if (!this.output.write(line)) await this.drain()
      } finally {
        this.#pendingBytes -= bytes
      }
    })
  }

  async flush(): Promise<void> {
    await this.#tail
  }

  private async drain(): Promise<void> {
    if (this.output.waitForDrain) return this.output.waitForDrain()
    if (this.output.once) await new Promise<void>((resolve) => this.output.once?.('drain', resolve))
    else throw new AppError('OUTPUT_BACKPRESSURE', 'JSONL output cannot accept backpressure')
  }
}
