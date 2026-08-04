import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CredentialPort,
  CredentialRef,
  CredentialStoreInput,
  SecretHandle,
} from '../../ports/credentials.js'
import { CredentialError, credentialRef } from '../../ports/credentials.js'
import {
  assertSafeDirectory,
  ensurePrivateDirectory,
  readNoFollow,
  removePrivateFile,
  replacePrivateFile,
  writePrivateFile,
} from '../persistence/safe-file.js'
import { type HeadlessKeySource, readHeadlessKey } from './headless-key.js'

const CREDENTIAL_FILE_VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MAX_CREDENTIAL_BYTES = 64 * 1024
const MAX_ENCODED_BYTES = 1 + NONCE_BYTES + TAG_BYTES + MAX_CREDENTIAL_BYTES
const KEY_DERIVATION_PURPOSE = 'braid-headless-credential-encryption:v1'
const AAD_PURPOSE = 'braid-headless-credential-aad:v1'
const STORE_IDENTITY_PATTERN = /^[0-9a-f]{64}$/u

class HeadlessSecretHandle implements SecretHandle {
  readonly ref: CredentialRef
  #value: Buffer | undefined

  constructor(ref: CredentialRef, value: Uint8Array) {
    this.ref = ref
    this.#value = Buffer.from(value)
  }

  read(): Uint8Array {
    if (this.#value === undefined) {
      throw new CredentialError('SECRET_HANDLE_CLOSED', 'The headless secret handle is closed')
    }
    return Buffer.from(this.#value)
  }

  dispose(): void {
    this.#value?.fill(0)
    this.#value = undefined
  }
}

/**
 * Stores credential-port values encrypted with a key derived from the explicit headless
 * database key. The key file remains the only external secret input; credential values
 * never enter config.
 */
export class HeadlessCredentialStore implements CredentialPort {
  readonly #root: string
  readonly #storeIdentity: string
  #key: Buffer | undefined

  constructor(options: {
    readonly root: string
    readonly keySource: HeadlessKeySource
    /** Stable workspace/config identity, normally the credential-directory digest. */
    readonly storeIdentity: string
  }) {
    if (!STORE_IDENTITY_PATTERN.test(options.storeIdentity)) {
      throw new CredentialError(
        'CREDENTIAL_STORE_IDENTITY',
        'Headless credential stores require a canonical workspace/config identity',
      )
    }
    this.#root = options.root
    this.#storeIdentity = options.storeIdentity
    const sourceKey = readHeadlessKey(options.keySource)
    try {
      this.#key = deriveCredentialKey(sourceKey, this.#storeIdentity)
    } finally {
      sourceKey.fill(0)
    }
  }

  async available(): Promise<boolean> {
    this.#assertOpen()
    ensurePrivateDirectory(this.#root)
    assertSafeDirectory(this.#root)
    const stat = statSync(this.#root)
    if ((stat.mode & 0o777) !== 0o700) {
      throw new CredentialError(
        'CREDENTIAL_STORE_PERMISSIONS',
        'The headless credential directory must have mode 0700',
      )
    }
    return true
  }

  async store(input: CredentialStoreInput): Promise<CredentialRef> {
    const key = this.#assertOpen()
    await this.available()
    if (input.value.length === 0) {
      throw new CredentialError('EMPTY_SECRET', 'Credential values must not be empty')
    }
    if (input.value.length > MAX_CREDENTIAL_BYTES) {
      throw new CredentialError('SECRET_TOO_LARGE', 'Credential values exceed the headless limit')
    }
    const ref = input.ref ?? credentialRef(`cred:v1:headless-${randomUUID()}`)
    const encoded = encryptCredential(key, this.#storeIdentity, ref, input.value)
    try {
      const path = this.#path(ref)
      const previous = readNoFollow(path, MAX_ENCODED_BYTES)
      if (previous === undefined) writePrivateFile(path, encoded)
      else {
        replacePrivateFile(path, encoded, {
          overwrite: true,
          expected: (current) => {
            if (current === undefined || !current.equals(previous)) {
              throw new CredentialError(
                'CREDENTIAL_CONFLICT',
                'The headless credential changed while it was being written',
              )
            }
          },
          maxExistingBytes: MAX_ENCODED_BYTES,
        })
      }
    } finally {
      encoded.fill(0)
    }
    return ref
  }

  async resolve(ref: CredentialRef): Promise<SecretHandle> {
    const key = this.#assertOpen()
    await this.available()
    const encoded = readNoFollow(this.#path(ref), MAX_ENCODED_BYTES)
    if (encoded === undefined) {
      throw new CredentialError('CREDENTIAL_NOT_FOUND', `Credential ${ref} was not found`)
    }
    let value: Buffer | undefined
    try {
      value = decryptCredential(key, this.#storeIdentity, ref, encoded)
      return new HeadlessSecretHandle(ref, value)
    } catch (error) {
      throw new CredentialError(
        'CREDENTIAL_INVALID',
        'The encrypted headless credential is invalid',
        {
          cause: error,
        },
      )
    } finally {
      encoded.fill(0)
      value?.fill(0)
    }
  }

  async remove(ref: CredentialRef): Promise<void> {
    this.#assertOpen()
    await this.available()
    removePrivateFile(this.#path(ref))
  }

  dispose(): void {
    this.#key?.fill(0)
    this.#key = undefined
  }

  #assertOpen(): Buffer {
    if (this.#key === undefined) {
      throw new CredentialError(
        'CREDENTIAL_STORE_UNAVAILABLE',
        'The headless credential store is closed',
      )
    }
    return this.#key
  }

  #path(ref: CredentialRef): string {
    const digest = createHash('sha256').update(ref).digest('hex')
    return join(this.#root, `${digest}.credential`)
  }
}

function deriveCredentialKey(sourceKey: Buffer, storeIdentity: string): Buffer {
  const identity = Buffer.from(storeIdentity, 'utf8')
  const salt = createHash('sha256')
    .update(`${KEY_DERIVATION_PURPOSE}:salt\u0000`, 'utf8')
    .update(identity)
    .digest()
  const info = Buffer.concat([Buffer.from(`${KEY_DERIVATION_PURPOSE}\u0000`, 'utf8'), identity])
  try {
    return Buffer.from(hkdfSync('sha256', sourceKey, salt, info, 32))
  } finally {
    identity.fill(0)
    salt.fill(0)
    info.fill(0)
  }
}

function encodeAadSegment(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.from(`${bytes.length}:`, 'utf8')
  const encoded = Buffer.concat([length, bytes])
  length.fill(0)
  bytes.fill(0)
  return encoded
}

function associatedData(storeIdentity: string, ref: CredentialRef): Buffer {
  const prefix = Buffer.from(`${AAD_PURPOSE}\u0000`, 'utf8')
  const identity = encodeAadSegment(storeIdentity)
  const credential = encodeAadSegment(ref)
  const aad = Buffer.concat([prefix, identity, credential])
  prefix.fill(0)
  identity.fill(0)
  credential.fill(0)
  return aad
}

function encryptCredential(
  key: Buffer,
  storeIdentity: string,
  ref: CredentialRef,
  value: Uint8Array,
): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const aad = associatedData(storeIdentity, ref)
  let ciphertext: Buffer | undefined
  try {
    cipher.setAAD(aad)
    ciphertext = Buffer.concat([cipher.update(value), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([Buffer.from([CREDENTIAL_FILE_VERSION]), nonce, tag, ciphertext])
  } finally {
    aad.fill(0)
    ciphertext?.fill(0)
  }
}

function decryptCredential(
  key: Buffer,
  storeIdentity: string,
  ref: CredentialRef,
  encoded: Buffer,
): Buffer {
  if (encoded.length < 1 + NONCE_BYTES + TAG_BYTES || encoded[0] !== CREDENTIAL_FILE_VERSION) {
    throw new Error('Unsupported encrypted credential format')
  }
  const nonce = encoded.subarray(1, 1 + NONCE_BYTES)
  const tag = encoded.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES)
  const ciphertext = encoded.subarray(1 + NONCE_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  const aad = associatedData(storeIdentity, ref)
  let value: Buffer | undefined
  try {
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    value = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    if (value.length > MAX_CREDENTIAL_BYTES) {
      value.fill(0)
      value = undefined
      throw new Error('Encrypted credential exceeds the headless limit')
    }
    return value
  } finally {
    aad.fill(0)
  }
}
