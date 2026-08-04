import { randomUUID } from 'node:crypto'
import type {
  CredentialPort,
  CredentialRef,
  CredentialStoreInput,
  SecretHandle,
} from '../../ports/credentials.js'
import { CredentialError, credentialRef } from '../../ports/credentials.js'

class MemorySecretHandle implements SecretHandle {
  readonly ref: CredentialRef
  #value: Buffer | undefined

  constructor(ref: CredentialRef, value: Uint8Array) {
    this.ref = ref
    this.#value = Buffer.from(value)
  }

  read(): Uint8Array {
    if (!this.#value) throw new CredentialError('SECRET_HANDLE_CLOSED', 'Secret handle is closed')
    return Buffer.from(this.#value)
  }

  dispose(): void {
    this.#value?.fill(0)
    this.#value = undefined
  }
}

export class MemoryCredentialStore implements CredentialPort {
  readonly #values = new Map<CredentialRef, Buffer>()
  #available = true

  setAvailable(available: boolean): void {
    this.#available = available
  }

  async store(input: CredentialStoreInput): Promise<CredentialRef> {
    this.#assertAvailable()
    const ref = input.ref ?? credentialRef(`cred:v1:memory-${randomUUID()}`)
    const value = Buffer.from(input.value)
    if (value.length === 0)
      throw new CredentialError('EMPTY_SECRET', 'Credential values must not be empty')
    const previous = this.#values.get(ref)
    previous?.fill(0)
    this.#values.set(ref, value)
    return ref
  }

  async resolve(ref: CredentialRef): Promise<SecretHandle> {
    this.#assertAvailable()
    const value = this.#values.get(ref)
    if (!value) throw new CredentialError('CREDENTIAL_NOT_FOUND', `Credential ${ref} was not found`)
    return new MemorySecretHandle(ref, value)
  }

  async remove(ref: CredentialRef): Promise<void> {
    this.#assertAvailable()
    const value = this.#values.get(ref)
    if (value) value.fill(0)
    this.#values.delete(ref)
  }

  async available(): Promise<boolean> {
    return this.#available
  }

  has(ref: CredentialRef): boolean {
    return this.#values.has(ref)
  }

  #assertAvailable(): void {
    if (!this.#available) {
      throw new CredentialError(
        'CREDENTIAL_STORE_UNAVAILABLE',
        'The in-memory credential store has been disabled',
      )
    }
  }
}
