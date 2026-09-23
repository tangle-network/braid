import { containsControlCharacters } from './redaction.js'

export type CredentialReferenceKind = 'os' | 'env' | 'session'

export interface CredentialReference {
  readonly kind: CredentialReferenceKind
  readonly id: string
}

export interface CredentialStore {
  store(input: { readonly label: string; readonly value: string }): Promise<CredentialReference>
  resolve(reference: CredentialReference): Promise<SecretHandle>
  remove(reference: CredentialReference): Promise<void>
  /** Release several owned references with best-effort rollback on failure. */
  removeMany?(references: readonly CredentialReference[]): Promise<void>
}

export interface SecretHandle {
  readonly use: <T>(operation: (value: string) => Promise<T>) => Promise<T>
}

export interface OperatingSystemCredentialBackend {
  readonly platform: 'macos-keychain' | 'windows-credential-manager' | 'linux-secret-service'
  set(label: string, value: string): Promise<void>
  get(label: string): Promise<string | undefined>
  delete(label: string): Promise<void>
}

function opaqueReference(reference: CredentialReference): CredentialReference {
  if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) {
    throw new Error('Credential reference must be an object')
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(reference, 'kind')
  const idDescriptor = Object.getOwnPropertyDescriptor(reference, 'id')
  if (
    kindDescriptor === undefined ||
    idDescriptor === undefined ||
    kindDescriptor.get !== undefined ||
    kindDescriptor.set !== undefined ||
    idDescriptor.get !== undefined ||
    idDescriptor.set !== undefined
  ) {
    throw new Error('Credential reference cannot contain accessors')
  }
  const kind = kindDescriptor.value
  const id = idDescriptor.value
  if (kind !== 'os' && kind !== 'env' && kind !== 'session') {
    throw new Error('Credential reference has an unknown kind')
  }
  if (typeof id !== 'string' || !id || id.length > 512 || containsControlCharacters(id)) {
    throw new Error('Credential reference must be opaque and single-line')
  }
  return Object.freeze({ kind, id })
}

function boundedSecret(value: string): SecretHandle {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_048_576) {
    throw new Error('Credential value is empty or oversized')
  }
  let active = value
  let claimed = false
  return Object.freeze({
    use: async <T>(operation: (value: string) => Promise<T>): Promise<T> => {
      if (typeof operation !== 'function')
        throw new Error('Credential operation must be a function')
      if (claimed || !active) throw new Error('Credential is unavailable')
      const secret = active
      claimed = true
      active = ''
      return operation(secret)
    },
  })
}

const BRAID_CREDENTIAL_NAMESPACE = 'braid'

function environmentName(name: string): string {
  if (typeof name !== 'string' || name.length > 512 || !/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
    throw new Error('Invalid environment variable reference')
  }
  return name
}

function validateLabel(label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(label)) {
    throw new Error('Credential label must be a safe single path component')
  }
  return label
}

export class OperatingSystemCredentialStore implements CredentialStore {
  readonly #backend: OperatingSystemCredentialBackend
  readonly #namespace: string

  constructor(backend: OperatingSystemCredentialBackend, namespace = 'braid') {
    if (namespace !== BRAID_CREDENTIAL_NAMESPACE) {
      throw new Error(
        `Operating-system credentials must use the exact ${BRAID_CREDENTIAL_NAMESPACE} namespace`,
      )
    }
    this.#backend = backend
    this.#namespace = BRAID_CREDENTIAL_NAMESPACE
  }

  async store(input: {
    readonly label: string
    readonly value: string
  }): Promise<CredentialReference> {
    if (
      typeof input.value !== 'string' ||
      input.value.length === 0 ||
      input.value.length > 1_048_576
    ) {
      throw new Error('Refusing to store an empty or oversized credential')
    }
    const label = validateLabel(input.label)
    const id = `${this.#namespace}/${label}`
    await this.#backend.set(id, input.value)
    return opaqueReference({ kind: 'os', id })
  }

  async resolve(reference: CredentialReference): Promise<SecretHandle> {
    const safe = opaqueReference(reference)
    if (safe.kind !== 'os')
      throw new Error('Credential reference does not belong to the operating-system store')
    const label = this.#labelFromReference(safe)
    const value = await this.#backend.get(`${this.#namespace}/${label}`)
    if (!value) throw new Error('Credential is unavailable in the operating-system store')
    return boundedSecret(value)
  }

  async remove(reference: CredentialReference): Promise<void> {
    const safe = opaqueReference(reference)
    if (safe.kind !== 'os')
      throw new Error('Credential reference does not belong to the operating-system store')
    const label = this.#labelFromReference(safe)
    await this.#backend.delete(`${this.#namespace}/${label}`)
  }

  async removeMany(references: readonly CredentialReference[]): Promise<void> {
    const safeReferences = references.map(opaqueReference)
    if (
      new Set(safeReferences.map((reference) => credentialReferenceString(reference))).size !==
      safeReferences.length
    ) {
      throw new Error('Credential release contains duplicate references')
    }
    const entries = await Promise.all(
      safeReferences.map(async (reference) => {
        if (reference.kind !== 'os') {
          throw new Error('Credential reference does not belong to the operating-system store')
        }
        const label = this.#labelFromReference(reference)
        const value = await this.#backend.get(`${this.#namespace}/${label}`)
        if (value !== undefined && (value.length === 0 || value.length > 1_048_576)) {
          throw new Error('Credential value is empty or oversized')
        }
        return { reference, label, value }
      }),
    )
    const removed: typeof entries = []
    try {
      for (const entry of entries) {
        await this.#backend.delete(`${this.#namespace}/${entry.label}`)
        removed.push(entry)
      }
    } catch (error) {
      let rollbackError: unknown
      for (const entry of removed.reverse()) {
        if (entry.value === undefined) continue
        try {
          await this.#backend.set(`${this.#namespace}/${entry.label}`, entry.value)
        } catch (restoreError) {
          rollbackError ??= restoreError
        }
      }
      if (rollbackError !== undefined) {
        throw new Error('Credential release failed and rollback was incomplete')
      }
      throw error
    }
  }

  #labelFromReference(reference: CredentialReference): string {
    const prefix = `${this.#namespace}/`
    if (!reference.id.startsWith(prefix)) {
      throw new Error('Credential reference belongs to a different Braid namespace')
    }
    return validateLabel(reference.id.slice(prefix.length))
  }
}

export class EnvironmentCredentialStore implements CredentialStore {
  async store(): Promise<CredentialReference> {
    throw new Error(
      'Environment credentials are references only; store the variable name, not its value',
    )
  }

  async resolve(reference: CredentialReference): Promise<SecretHandle> {
    const safe = opaqueReference(reference)
    if (safe.kind !== 'env') throw new Error('Credential reference is not an environment reference')
    const name = environmentName(safe.id)
    const value = process.env[name]
    if (!value) throw new Error('Environment credential is unavailable')
    return boundedSecret(value)
  }

  async remove(): Promise<void> {
    throw new Error('Environment-variable references are not owned by Braid')
  }
}

export function environmentCredentialReference(name: string): CredentialReference {
  return opaqueReference({ kind: 'env', id: environmentName(name) })
}

export function sessionCredentialReference(id: string): CredentialReference {
  return opaqueReference({ kind: 'session', id })
}

export function credentialReferenceString(reference: CredentialReference): string {
  const safe = opaqueReference(reference)
  return `${safe.kind}:${safe.id}`
}

export function parseCredentialReference(value: string): CredentialReference {
  if (typeof value !== 'string' || value.length > 1_024) {
    throw new Error('Credential reference must be a bounded string')
  }
  const separator = value.indexOf(':')
  if (separator <= 0) throw new Error('Credential reference must use kind:id form')
  const kind = value.slice(0, separator)
  if (kind !== 'os' && kind !== 'env' && kind !== 'session')
    throw new Error(`Unknown credential reference kind: ${kind}`)
  return opaqueReference({ kind, id: value.slice(separator + 1) })
}
