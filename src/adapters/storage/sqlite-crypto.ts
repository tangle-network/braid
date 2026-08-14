import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import {
  isSafeBooleanTelemetryField,
  isSafeNumericTelemetryField,
  isSafeTokenUsageRecord,
} from '../../domain/bounded-structured.js'
import { canonicalJson } from '../../domain/canonical.js'
import type { JsonValue } from '../../ports/storage.js'
import { isJsonValue } from '../../ports/storage.js'
import { StorageError } from './sqlite-errors.js'

const VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16

export function payloadChecksum(payload: JsonValue): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

export function encryptPayload(payload: JsonValue, key: Buffer): Buffer {
  if (key.length !== 32)
    throw new StorageError('CONTENT_KEY_INVALID', 'Content keys must be exactly 32 bytes')
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const plaintext = Buffer.from(canonicalJson(payload))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  plaintext.fill(0)
  return Buffer.concat([Buffer.from([VERSION]), nonce, tag, ciphertext])
}

export function decryptPayload(encoded: Buffer, key: Buffer): JsonValue {
  if (key.length !== 32 || encoded.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new StorageError('PAYLOAD_DECRYPT_FAILED', 'Encrypted payload has invalid dimensions')
  }
  if (encoded[0] !== VERSION)
    throw new StorageError('PAYLOAD_VERSION', 'Encrypted payload version is unsupported')
  const nonce = encoded.subarray(1, 1 + NONCE_BYTES)
  const tag = encoded.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES)
  const ciphertext = encoded.subarray(1 + NONCE_BYTES + TAG_BYTES)
  let plaintext: Buffer | undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const value: unknown = JSON.parse(plaintext.toString('utf8'))
    if (!isJsonValue(value)) throw new Error('payload is not JSON')
    return value
  } catch (error) {
    throw new StorageError(
      'PAYLOAD_DECRYPT_FAILED',
      'The conversation content key did not decrypt the payload',
      {
        cause: error,
      },
    )
  } finally {
    plaintext?.fill(0)
  }
}

export function tombstone(reason: string): JsonValue {
  const safeReason =
    reason === 'retention' || reason === 'redaction' || reason === 'destruction'
      ? reason
      : 'redacted'
  return { redacted: true, reason: safeReason }
}

const SECRET_KEY =
  /(secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key)/iu
const SAFE_REFERENCE_SUFFIX = /(ref|name|kind)$/iu

function isSafeInteractionCapabilityFlag(path: string, key: string, value: JsonValue): boolean {
  return (
    path.endsWith('.capabilities.environment.interactions') &&
    key === 'secretAnswers' &&
    typeof value === 'boolean'
  )
}

function secretFieldNames(value: JsonValue): readonly string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const fields = (value as Readonly<Record<string, JsonValue>>).fields
  if (!Array.isArray(fields)) return []
  const names: string[] = []
  for (const field of fields) {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      throw new StorageError('INTERACTION_SPEC_INVALID', 'Interaction answerSpec field is invalid')
    }
    const item = field as Readonly<Record<string, JsonValue>>
    if (typeof item.name !== 'string' || item.name.length === 0 || typeof item.type !== 'string') {
      throw new StorageError('INTERACTION_SPEC_INVALID', 'Interaction answerSpec field is invalid')
    }
    if (item.type === 'secret') {
      if (Object.hasOwn(item, 'default')) {
        throw new StorageError(
          'INTERACTION_SPEC_INVALID',
          `Secret interaction field ${item.name} cannot define a default`,
        )
      }
      names.push(item.name)
    }
  }
  return names
}

function rejectTypedSecretAnswers(value: JsonValue): void {
  function inspectContainer(
    container: Readonly<Record<string, JsonValue>>,
    spec: JsonValue,
    path: string,
  ): void {
    const names = secretFieldNames(spec)
    if (names.length === 0) return
    const rejectObject = (candidate: JsonValue, candidatePath: string): void => {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return
      for (const name of names) {
        if (Object.hasOwn(candidate, name)) {
          throw new StorageError(
            'SECRET_PAYLOAD_REJECTED',
            `Secret-designated interaction field ${candidatePath}.${name} cannot be persisted`,
          )
        }
      }
    }
    for (const [key, child] of Object.entries(container)) {
      if (key === 'answerSpec' || key === 'request') continue
      if (/^(answer|answers|data|publicData|response|value)$/u.test(key)) {
        rejectObject(child, `${path}.${key}`)
      }
      if (names.includes(key)) {
        throw new StorageError(
          'SECRET_PAYLOAD_REJECTED',
          `Secret-designated interaction field ${path}.${key} cannot be persisted`,
        )
      }
    }
  }

  function visit(node: JsonValue, path: string): void {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        visit(child, `${path}[${index}]`)
      })
      return
    }
    const object = node as Readonly<Record<string, JsonValue>>
    const spec = object.answerSpec
    if (spec !== undefined) inspectContainer(object, spec, path)
    const request = object.request
    if (
      request !== undefined &&
      request !== null &&
      typeof request === 'object' &&
      !Array.isArray(request)
    ) {
      const requestObject = request as Readonly<Record<string, JsonValue>>
      if (requestObject.answerSpec !== undefined)
        inspectContainer(object, requestObject.answerSpec, path)
    }
    for (const [key, child] of Object.entries(object)) visit(child, `${path}.${key}`)
  }
  visit(value, '$')
}

export function assertPersistablePayload(value: JsonValue): void {
  if (!isJsonValue(value)) {
    throw new StorageError('PAYLOAD_INVALID', 'Journal payload must be finite JSON')
  }

  rejectTypedSecretAnswers(value)

  function visit(node: JsonValue, path: string, secretDesignated = false): void {
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        visit(child, `${path}[${index}]`, secretDesignated)
      })
      return
    }
    if (node === null || typeof node !== 'object') return
    const object = node as Readonly<Record<string, JsonValue>>
    const containsSecret =
      secretDesignated ||
      object.containsSecret === true ||
      object.secretDesignated === true ||
      object.isSecret === true
    for (const [key, child] of Object.entries(node)) {
      const isSecretMarker =
        key === 'containsSecret' || key === 'secretDesignated' || key === 'isSecret'
      const isSafeTelemetry =
        !containsSecret &&
        (isSafeNumericTelemetryField(key, child) ||
          isSafeBooleanTelemetryField(key, child) ||
          isSafeTokenUsageRecord(key, child))
      const isSafeCapability = !containsSecret && isSafeInteractionCapabilityFlag(path, key, child)
      if (
        SECRET_KEY.test(key) &&
        !SAFE_REFERENCE_SUFFIX.test(key) &&
        !isSecretMarker &&
        !isSafeTelemetry &&
        !isSafeCapability
      ) {
        throw new StorageError(
          'SECRET_PAYLOAD_REJECTED',
          `Secret-bearing field ${path}.${key} cannot be persisted`,
        )
      }
      if (containsSecret && /^(answer|data|publicData|response|value)$/u.test(key)) {
        throw new StorageError(
          'SECRET_PAYLOAD_REJECTED',
          `Secret-designated field ${path}.${key} cannot be persisted`,
        )
      }
      visit(child, `${path}.${key}`, containsSecret)
    }
  }
  visit(value, '$')
}
