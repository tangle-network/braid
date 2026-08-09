import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const SECRET_KEY =
  /(?:secret|token|password|passphrase|authorization|credential|api[_-]?key|private[_-]?key|cookie)/iu
const SECRET_VALUE = /(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/iu

export function redact(value, key = '') {
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key) || SECRET_VALUE.test(value)) return '[redacted]'
    return value.replaceAll(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[redacted]')
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => [name, redact(child, name)]),
  )
}

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function eventKinds(responses) {
  return [
    ...new Set(
      responses
        .filter((response) => response.type === 'event')
        .map((response) => response.event?.kind)
        .filter(Boolean),
    ),
  ]
}

export function redactedReceipt(details) {
  const receipt = details?.data?.receipt
  return receipt ? redact(receipt) : undefined
}

export async function writeEvidence(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(redact(value), null, 2)}\n`, { mode: 0o600 })
}
