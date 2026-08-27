export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const character of value) bytes += utf8BytesForCharacter(character).length
  return bytes
}

export function utf8BytesForCharacter(character: string): readonly number[] {
  const codePoint = character.codePointAt(0) ?? 0xfffd
  const code = codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint
  if (code <= 0x7f) return [code]
  if (code <= 0x7ff) return [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
  if (code <= 0xffff) {
    return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
  }
  return [
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 0x3f),
    0x80 | ((code >> 6) & 0x3f),
    0x80 | (code & 0x3f),
  ]
}
