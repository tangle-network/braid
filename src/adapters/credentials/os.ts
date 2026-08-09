import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  CredentialPort,
  CredentialRef,
  CredentialStoreInput,
  SecretHandle,
} from '../../ports/credentials.js'
import { CredentialError, credentialRef } from '../../ports/credentials.js'

const SERVICE_NAME = 'Braid'

export interface NativeKeyringEntry {
  setSecret(secret: Uint8Array): Promise<void>
  getSecret(): Promise<Uint8Array | undefined>
  deleteCredential(): Promise<boolean>
}

export type NativeKeyringEntryFactory = (service: string, account: string) => NativeKeyringEntry

class LazyNativeKeyringEntry implements NativeKeyringEntry {
  readonly #service: string
  readonly #account: string
  #entry: Promise<NativeKeyringEntry> | undefined

  constructor(service: string, account: string) {
    this.#service = service
    this.#account = account
  }

  async setSecret(secret: Uint8Array): Promise<void> {
    await (await this.load()).setSecret(secret)
  }

  async getSecret(): Promise<Uint8Array | undefined> {
    return (await this.load()).getSecret()
  }

  async deleteCredential(): Promise<boolean> {
    return (await this.load()).deleteCredential()
  }

  private load(): Promise<NativeKeyringEntry> {
    this.#entry ??= import('@napi-rs/keyring').then(
      ({ AsyncEntry }) => new AsyncEntry(this.#service, this.#account),
    )
    return this.#entry
  }
}

const createNativeEntry: NativeKeyringEntryFactory = (service, account) =>
  new LazyNativeKeyringEntry(service, account)

class ProcessSecretHandle implements SecretHandle {
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

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function isMissingCredential(error: unknown): boolean {
  const code = errorCode(error)
    ?.replaceAll(/[-_\s]/gu, '')
    .toLowerCase()
  if (code === 'noentry' || code === 'notfound' || code === 'credentialnotfound') return true
  return /(?:no|missing)\s+(?:matching\s+)?(?:credential|entry)|not found/iu.test(errorText(error))
}

function facilityUnavailable(platform: string, cause: unknown): CredentialError {
  return new CredentialError(
    'CREDENTIAL_STORE_UNAVAILABLE',
    `${platform} credential facility is unavailable`,
    { cause },
  )
}

abstract class NativeCredentialStore implements CredentialPort {
  abstract readonly platform: string
  readonly #entryFactory: NativeKeyringEntryFactory

  constructor(entryFactory: NativeKeyringEntryFactory = createNativeEntry) {
    this.#entryFactory = entryFactory
  }

  #entry(account: string): NativeKeyringEntry {
    return this.#entryFactory(SERVICE_NAME, account)
  }

  async store(input: CredentialStoreInput): Promise<CredentialRef> {
    const ref = input.ref ?? credentialRef(`cred:v1:${this.platform}-${randomUUID()}`)
    if (input.value.length === 0) {
      throw new CredentialError('EMPTY_SECRET', 'Credential values must not be empty')
    }
    const secret = Buffer.from(input.value)
    try {
      await this.#entry(ref).setSecret(secret)
    } catch (error) {
      throw new CredentialError('CREDENTIAL_WRITE_FAILED', 'The credential could not be stored', {
        cause: error,
      })
    } finally {
      secret.fill(0)
    }
    return ref
  }

  async resolve(ref: CredentialRef): Promise<SecretHandle> {
    let secret: Uint8Array | undefined
    try {
      secret = await this.#entry(ref).getSecret()
    } catch (error) {
      if (isMissingCredential(error)) {
        throw new CredentialError('CREDENTIAL_NOT_FOUND', `Credential ${ref} was not found`)
      }
      throw facilityUnavailable(this.platform, error)
    }
    if (!secret || secret.length === 0) {
      secret?.fill(0)
      throw new CredentialError('CREDENTIAL_NOT_FOUND', `Credential ${ref} was not found`)
    }
    try {
      return new ProcessSecretHandle(ref, secret)
    } finally {
      secret.fill(0)
    }
  }

  async remove(ref: CredentialRef): Promise<void> {
    const entry = this.#entry(ref)
    try {
      const removed = await entry.deleteCredential()
      if (removed) return
      const remaining = await entry.getSecret()
      try {
        if (remaining === undefined || remaining.length === 0) return
      } finally {
        remaining?.fill(0)
      }
      throw new CredentialError(
        'CREDENTIAL_REMOVE_FAILED',
        'The credential store reported success without removing the credential',
      )
    } catch (error) {
      if (isMissingCredential(error)) return
      if (error instanceof CredentialError) throw error
      throw new CredentialError('CREDENTIAL_REMOVE_FAILED', 'The credential could not be removed', {
        cause: error,
      })
    }
  }

  async available(): Promise<boolean> {
    const entry = this.#entry(`__braid_availability_probe_v1__-${randomUUID()}`)
    const expected = randomBytes(32)
    let observed: Uint8Array | undefined
    let cleanupAttempted = false
    try {
      await entry.setSecret(expected)
      observed = await entry.getSecret()
      const matches =
        observed !== undefined &&
        observed.length === expected.length &&
        timingSafeEqual(observed, expected)
      cleanupAttempted = true
      const removed = await entry.deleteCredential()
      return matches && removed
    } catch {
      if (!cleanupAttempted) await entry.deleteCredential().catch(() => false)
      return false
    } finally {
      expected.fill(0)
      observed?.fill(0)
    }
  }
}

export class MacOsKeychainCredentialStore extends NativeCredentialStore {
  readonly platform = 'macos-keychain'
}

export class LinuxSecretServiceCredentialStore extends NativeCredentialStore {
  readonly platform = 'linux-secret-service'
}

export class WindowsCredentialManagerStore extends NativeCredentialStore {
  readonly platform = 'windows-credential-manager'
}

export function createOperatingSystemCredentialStore(): CredentialPort {
  switch (process.platform) {
    case 'darwin':
      return new MacOsKeychainCredentialStore()
    case 'linux':
      return new LinuxSecretServiceCredentialStore()
    case 'win32':
      return new WindowsCredentialManagerStore()
    default:
      throw new CredentialError(
        'CREDENTIAL_STORE_UNAVAILABLE',
        `No maintained credential adapter is available for ${process.platform}`,
      )
  }
}
