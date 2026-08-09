declare const CREDENTIAL_REF_BRAND: unique symbol

export type CredentialRef = string & {
  readonly [CREDENTIAL_REF_BRAND]?: 'CredentialRef'
}

export interface CredentialStoreInput {
  /** An opaque stable reference. If omitted, the adapter creates one. */
  readonly ref?: CredentialRef
  readonly value: Uint8Array
  readonly label?: string
}

export interface SecretHandle {
  readonly ref: CredentialRef
  read(): Uint8Array
  dispose(): void
}

export interface CredentialPort {
  store(input: CredentialStoreInput): Promise<CredentialRef>
  resolve(ref: CredentialRef): Promise<SecretHandle>
  remove(ref: CredentialRef): Promise<void>
  available(): Promise<boolean>
}

export class CredentialError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'CredentialError'
    this.code = code
  }
}

export function credentialRef(value: string): CredentialRef {
  if (!/^cred:v1:[A-Za-z0-9._~-]+$/.test(value)) {
    throw new CredentialError(
      'INVALID_CREDENTIAL_REF',
      'Credential references must be opaque v1 values',
    )
  }
  return value as CredentialRef
}
