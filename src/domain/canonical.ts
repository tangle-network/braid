import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical-json.js'
import { createDigest, type Digest } from './ids.js'

export { canonicalJson }

/** The SHA-256 of a value's canonical text. */
export function canonicalDigest(value: unknown): Digest {
  return createDigest(createHash('sha256').update(canonicalJson(value)).digest('hex'))
}
