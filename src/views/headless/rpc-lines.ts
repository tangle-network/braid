import { AppError } from '../../app/application.js'
import { MAX_RPC_LINE_BYTES } from '../../domain/bounds.js'

export interface RpcInput extends AsyncIterable<string | Uint8Array> {}

export async function* linesOf(input: RpcInput): AsyncGenerator<string> {
  let chunks: Uint8Array[] = []
  let bytes = 0
  const add = (chunk: Uint8Array): void => {
    if (bytes + chunk.byteLength > MAX_RPC_LINE_BYTES) {
      throw new AppError(
        'INPUT_TOO_LARGE',
        `JSONL input lines are limited to ${MAX_RPC_LINE_BYTES} bytes`,
      )
    }
    if (chunk.byteLength > 0) chunks.push(chunk)
    bytes += chunk.byteLength
  }
  const take = (): string | undefined => {
    if (bytes === 0) return undefined
    const line = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      bytes,
    ).toString('utf8')
    chunks = []
    bytes = 0
    return line
  }
  const consume = async function* (chunk: Uint8Array): AsyncGenerator<string> {
    let start = 0
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue
      add(chunk.subarray(start, index))
      const line = take()
      if (line !== undefined) yield line
      start = index + 1
    }
    add(chunk.subarray(start))
  }
  for await (const chunk of input) {
    yield* consume(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  }
  const line = take()
  if (line !== undefined) yield line
}
