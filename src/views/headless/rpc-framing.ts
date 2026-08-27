import { utf8BytesForCharacter } from '../../domain/utf8.js'
import { RpcParseError } from './rpc-errors.js'
import { MAX_RPC_LINE_BYTES, type RpcInput } from './rpc-types.js'

export async function* linesOf(input: RpcInput): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const lineBytes = new Uint8Array(MAX_RPC_LINE_BYTES)
  let length = 0
  let pendingHighSurrogate: string | undefined

  const appendByte = (byte: number): void => {
    if (length >= MAX_RPC_LINE_BYTES) {
      throw new RpcParseError(
        'LINE_TOO_LARGE',
        `JSONL line must not exceed ${MAX_RPC_LINE_BYTES} bytes`,
      )
    }
    lineBytes[length] = byte
    length += 1
  }

  const readLine = (): string => {
    let end = length
    if (end > 0 && lineBytes[end - 1] === 0x0d) end -= 1
    const line = decoder.decode(lineBytes.subarray(0, end))
    length = 0
    return line
  }

  const appendBytes = (bytes: readonly number[]): void => {
    for (const byte of bytes) appendByte(byte)
  }

  const isHighSurrogate = (character: string): boolean => {
    const code = character.charCodeAt(0)
    return character.length === 1 && code >= 0xd800 && code <= 0xdbff
  }

  const isLowSurrogate = (character: string): boolean => {
    const code = character.charCodeAt(0)
    return character.length === 1 && code >= 0xdc00 && code <= 0xdfff
  }

  const processCharacter = (character: string): string | undefined => {
    if (pendingHighSurrogate !== undefined) {
      if (isLowSurrogate(character)) {
        const pair = `${pendingHighSurrogate}${character}`
        pendingHighSurrogate = undefined
        return pair
      }
      appendBytes(utf8BytesForCharacter(pendingHighSurrogate))
      pendingHighSurrogate = undefined
    }
    if (isHighSurrogate(character)) {
      pendingHighSurrogate = character
      return undefined
    }
    return character
  }

  for await (const chunk of input) {
    if (typeof chunk === 'string') {
      for (const character of chunk) {
        const processed = processCharacter(character)
        if (processed === undefined) continue
        for (const byte of utf8BytesForCharacter(processed)) {
          if (byte === 0x0a) yield readLine()
          else appendByte(byte)
        }
      }
      continue
    }
    if (pendingHighSurrogate !== undefined) {
      appendBytes(utf8BytesForCharacter(pendingHighSurrogate))
      pendingHighSurrogate = undefined
    }
    for (const byte of chunk) {
      if (byte === 0x0a) yield readLine()
      else appendByte(byte)
    }
  }
  if (pendingHighSurrogate !== undefined) appendBytes(utf8BytesForCharacter(pendingHighSurrogate))
  if (length > 0) yield readLine()
}
