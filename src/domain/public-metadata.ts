import { containsUnsafeControlCharacter } from './text.js'

const MAX_ENTRIES = 64
const MAX_KEY_BYTES = 128
const MAX_VALUE_BYTES = 1024
const MAX_TOTAL_BYTES = 16 * 1024
const SECRET_NAME =
  /(secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key)/iu
const SAFE_REFERENCE_SUFFIX = /(ref|name|kind)$/iu
const SECRET_TEXT =
  /(?:secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key)\s*[:=]/iu

function containsCredentialUrl(value: string): boolean {
  if (/:\/\/[^/\s:@]+:[^/\s@]+@/u.test(value)) return true
  try {
    const url = new URL(value)
    if (url.username || url.password) return true
    return [...url.searchParams.keys()].some((key) => SECRET_NAME.test(key))
  } catch {
    return false
  }
}

export function isSafePublicMetadata(
  metadata: Readonly<Record<string, unknown>>,
): metadata is Readonly<Record<string, string>> {
  const entries = Object.entries(metadata)
  if (entries.length > MAX_ENTRIES) return false
  let totalBytes = 0
  for (const [key, value] of entries) {
    if (
      typeof value !== 'string' ||
      Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES ||
      Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES ||
      !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(key) ||
      (SECRET_NAME.test(key) && !SAFE_REFERENCE_SUFFIX.test(key)) ||
      containsUnsafeControlCharacter(value) ||
      SECRET_TEXT.test(value) ||
      containsCredentialUrl(value)
    ) {
      return false
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8')
    if (totalBytes > MAX_TOTAL_BYTES) return false
  }
  return true
}
