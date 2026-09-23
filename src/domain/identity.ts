import { createHmac } from 'node:crypto'
import { canonicalDigest } from './canonical.js'

export function lengthDelimitedIdentity(...parts: readonly string[]): string {
  return parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|')
}

export function typedIdentityDigest(kind: string, value: Record<string, unknown>): string {
  return canonicalDigest({ schema: 'braid.identity.v1', kind, value })
}

export function keyedDigest(value: unknown, key: string | Uint8Array): string {
  const secret = typeof key === 'string' ? Buffer.from(key, 'utf8') : key
  return createHmac('sha256', secret).update(canonicalDigest(value)).digest('hex')
}
