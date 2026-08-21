export interface RpcInput extends AsyncIterable<string | Uint8Array> {}

export interface RpcOutput {
  write(chunk: string): boolean
  once?(event: 'drain', listener: () => void): unknown
}

export const RPC_REPLAY_MAX_ENTRIES = 256
export const RPC_REPLAY_MAX_BYTES = 8 * 1024 * 1024

export interface RequestRecord {
  /** Canonical text of the request this identifier was first used with. */
  readonly identity: string
  readonly responses: string[]
  bytes: number
  replayable: boolean
}
