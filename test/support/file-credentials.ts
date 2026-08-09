import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CredentialPort,
  CredentialRef,
  CredentialStoreInput,
  SecretHandle,
} from '../../src/ports/credentials.js'
import { CredentialError, credentialRef } from '../../src/ports/credentials.js'

class FileSecretHandle implements SecretHandle {
  readonly ref: CredentialRef
  #value: Buffer | undefined

  constructor(ref: CredentialRef, value: Uint8Array) {
    this.ref = ref
    this.#value = Buffer.from(value)
  }

  read(): Uint8Array {
    if (this.#value === undefined)
      throw new CredentialError('SECRET_HANDLE_CLOSED', 'Secret handle is closed')
    return Buffer.from(this.#value)
  }

  dispose(): void {
    this.#value?.fill(0)
    this.#value = undefined
  }
}

export class FileCredentialStore implements CredentialPort {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    await chmod(this.#root, 0o700)
  }

  async store(input: CredentialStoreInput): Promise<CredentialRef> {
    await this.initialize()
    const ref =
      input.ref ??
      credentialRef(`cred:v1:test-${createHash('sha256').update(String(Date.now())).digest('hex')}`)
    const path = this.#path(ref)
    const value = Buffer.from(input.value)
    if (value.length === 0)
      throw new CredentialError('EMPTY_SECRET', 'Credential values must not be empty')
    await writeFile(path, value, { mode: 0o600 })
    await chmod(path, 0o600)
    value.fill(0)
    return ref
  }

  async resolve(ref: CredentialRef): Promise<SecretHandle> {
    try {
      return new FileSecretHandle(ref, await readFile(this.#path(ref)))
    } catch (error) {
      throw new CredentialError('CREDENTIAL_NOT_FOUND', `Credential ${ref} was not found`, {
        cause: error,
      })
    }
  }

  async remove(ref: CredentialRef): Promise<void> {
    await rm(this.#path(ref), { force: true })
  }

  async available(): Promise<boolean> {
    await this.initialize()
    return true
  }

  path(ref: CredentialRef): string {
    return this.#path(ref)
  }

  async has(ref: CredentialRef): Promise<boolean> {
    try {
      await readFile(this.#path(ref))
      return true
    } catch {
      return false
    }
  }

  #path(ref: CredentialRef): string {
    const digest = createHash('sha256').update(ref).digest('hex')
    return join(this.#root, `${digest}.secret`)
  }
}
