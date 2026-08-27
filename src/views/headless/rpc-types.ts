export interface RpcInput extends AsyncIterable<string | Uint8Array> {}

export interface RpcOutput {
  write(chunk: string): boolean
}

export const MAX_RPC_LINE_BYTES = 1024 * 1024
export const MAX_RPC_REQUEST_ID_BYTES = 256
export const MAX_RPC_OPERATION_ID_BYTES = 256
export const MAX_RPC_FIELD_BYTES = 64 * 1024
export const MAX_RPC_COMMAND_TEXT_BYTES = 512 * 1024
export const RPC_REPLAY_MAX_ENTRIES = 256
export const RPC_REPLAY_MAX_BYTES = 8 * 1024 * 1024

export interface RequestRecord {
  readonly digest: string
  readonly responses: string[]
  bytes: number
  replayable: boolean
}
