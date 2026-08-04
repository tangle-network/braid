import { RpcParseError } from './rpc-errors.js'

export const MAX_RPC_LINE_BYTES = 5 * 1024 * 1024
export const MAX_PROTOCOL_DEPTH = 32
export const MAX_PROTOCOL_FIELDS = 256
export const MAX_PROTOCOL_ITEMS = 4096
export const MAX_PROTOCOL_LIST_ITEMS = 256
export const MAX_PROTOCOL_STRING_BYTES = 2 * 1024 * 1024
export const MAX_PROTOCOL_IDENTIFIER_BYTES = 4096

export function assertValidUnicodeString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff)
        throw new RpcParseError('INVALID_UTF8', `${label} contains an unpaired surrogate`)
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new RpcParseError('INVALID_UTF8', `${label} contains an unpaired surrogate`)
    }
  }
}

export function assertBoundedIdentifier(value: string, label: string): string {
  assertValidUnicodeString(value, label)
  if (Buffer.byteLength(value, 'utf8') > MAX_PROTOCOL_IDENTIFIER_BYTES)
    throw new RpcParseError('INVALID_PARAMS', `${label} exceeds the identifier byte limit`)
  return value
}

export function assertBoundedRequestShape(value: unknown): void {
  const seen = new WeakSet<object>()
  let fields = 0
  let items = 0
  let bytes = 0
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_PROTOCOL_DEPTH)
      throw new RpcParseError('INVALID_PARAMS', 'Request nesting exceeds the protocol limit')
    if (typeof candidate === 'string') {
      assertValidUnicodeString(candidate, 'Request string')
      bytes += Buffer.byteLength(candidate, 'utf8')
      if (Buffer.byteLength(candidate, 'utf8') > MAX_PROTOCOL_STRING_BYTES)
        throw new RpcParseError('INVALID_PARAMS', 'Request string exceeds the protocol limit')
      if (bytes > MAX_RPC_LINE_BYTES)
        throw new RpcParseError('INVALID_PARAMS', 'Request content exceeds the protocol limit')
      return
    }
    if (candidate === null || typeof candidate !== 'object') return
    if (seen.has(candidate)) throw new RpcParseError('INVALID_PARAMS', 'Request contains a cycle')
    seen.add(candidate)
    try {
      if (Array.isArray(candidate)) {
        items += candidate.length
        if (items > MAX_PROTOCOL_ITEMS)
          throw new RpcParseError('INVALID_PARAMS', 'Request item count exceeds the protocol limit')
        for (const item of candidate) visit(item, depth + 1)
        return
      }
      const entries = Object.entries(candidate)
      fields += entries.length
      if (fields > MAX_PROTOCOL_FIELDS)
        throw new RpcParseError('INVALID_PARAMS', 'Request field count exceeds the protocol limit')
      for (const [key, item] of entries) {
        visit(key, depth + 1)
        visit(item, depth + 1)
      }
    } finally {
      seen.delete(candidate)
    }
  }
  visit(value, 0)
}
