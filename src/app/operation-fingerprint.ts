import { createHmac, randomBytes } from 'node:crypto'
import { canonicalJson } from '../domain/canonical.js'

const FINGERPRINT_DOMAIN = 'braid-operation-fingerprint:v1\u0000'

interface OperationFingerprintInput {
  readonly effectKind: string
  readonly request: unknown
}

export interface OperationFingerprintPort {
  readonly fingerprint: (input: {
    readonly effectKind: string
    readonly request: unknown
  }) => string
}

export function createInMemoryOperationFingerprint(): OperationFingerprintPort {
  const key = randomBytes(32)
  return createOperationFingerprint(key)
}

export function createOperationFingerprint(key: Uint8Array): OperationFingerprintPort {
  if (key.byteLength < 16) throw new TypeError('Operation fingerprint key is too short')
  return Object.freeze({
    fingerprint: ({ effectKind, request }: OperationFingerprintInput) =>
      createHmac('sha256', key)
        .update(FINGERPRINT_DOMAIN)
        .update(effectKind)
        .update('\u0000')
        .update(canonicalJson(request))
        .digest('hex'),
  })
}
