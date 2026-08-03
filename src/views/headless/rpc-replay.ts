import type { BraidResponse } from './protocol.js'

export const RPC_REPLAY_MAX_ENTRIES = 256
export const RPC_REPLAY_MAX_BYTES = 8 * 1024 * 1024

export interface RequestRecord {
  readonly digest: string
  readonly responses: string[]
  bytes: number
  replayable: boolean
}

export class RpcReplayStore {
  readonly #requests = new Map<string, RequestRecord>()
  #bytes = 0

  get(requestId: string): RequestRecord | undefined {
    return this.#requests.get(requestId)
  }

  add(requestId: string, digest: string): RequestRecord {
    const record: RequestRecord = { digest, responses: [], bytes: 0, replayable: true }
    this.#requests.set(requestId, record)
    this.#trim()
    return record
  }

  remember(record: RequestRecord, response: BraidResponse, write: (line: string) => void): void {
    const line = `${JSON.stringify(response)}\n`
    const bytes = Buffer.byteLength(line)
    if (record.replayable && record.bytes + bytes <= RPC_REPLAY_MAX_BYTES) {
      record.responses.push(line)
      record.bytes += bytes
      this.#bytes += bytes
      this.#trim()
    } else if (record.replayable) {
      this.#bytes -= record.bytes
      record.responses.length = 0
      record.bytes = 0
      record.replayable = false
    }
    write(line)
  }

  replay(record: RequestRecord, write: (line: string) => void): void {
    for (const response of record.responses) write(response)
  }

  #trim(): void {
    while (this.#requests.size > RPC_REPLAY_MAX_ENTRIES || this.#bytes > RPC_REPLAY_MAX_BYTES) {
      const oldest = this.#requests.entries().next().value as [string, RequestRecord] | undefined
      if (!oldest) break
      this.#requests.delete(oldest[0])
      this.#bytes -= oldest[1].bytes
    }
  }
}
