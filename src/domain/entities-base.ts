export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

export type IsoDateTime = string

export interface MissingHistoryRange {
  readonly runId: import('./ids.js').RunId
  readonly fromSequence: number
  readonly toSequence?: number
  readonly reason: 'gap' | 'expired-cursor' | 'provider-missing' | 'replay-unsupported'
}
