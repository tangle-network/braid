const secretKeys = new Set([
  'authorization',
  'bearer',
  'token',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'secret',
  'secretvalue',
  'password',
  'cookie',
  'credential',
  'credentialvalue',
])

function isSecretKey(key) {
  const normalized = key.replaceAll(/[-_]/gu, '').toLowerCase()
  return secretKeys.has(normalized)
}

export function redactString(value) {
  return value
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/giu, '$1[redacted]@')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/gu, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, '[redacted]')
    .replace(
      /((?:token|access[-_]?token|refresh[-_]?token|api[-_]?key|secret|client[-_]?secret|password|authorization|credential)\s*[:=]\s*)[^,\s;&#]+/giu,
      '$1[redacted]',
    )
    .replace(
      /([?&](?:token|access[-_]?token|refresh[-_]?token|api[-_]?key|secret|client[-_]?secret|password|authorization|credential)=)[^&\s#]+/giu,
      '$1[redacted]',
    )
}

export function evidenceValue(value, key = '', depth = 0) {
  if (isSecretKey(key)) return '[redacted]'
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > 8) return '[depth-limited]'
  if (Array.isArray(value)) return value.map((item) => evidenceValue(item, key, depth + 1))
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      evidenceValue(entryValue, entryKey, depth + 1),
    ]),
  )
}
