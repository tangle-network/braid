import type { ConnectionKind } from '../../domain/entities.js'
import { isSensitiveFieldName, sanitizeTerminalText } from '../shared/sanitize.js'

export type ConnectionMetadataKind = ConnectionKind
export type ConnectionMetadataField =
  | 'kind'
  | 'name'
  | 'endpoint'
  | 'region'
  | 'account'
  | 'credentials'
  | 'metadata'

/** The only durable value the editor can emit. Credential values are absent by design. */
export interface ConnectionMetadataDraft {
  readonly kind: ConnectionMetadataKind
  readonly name: string
  readonly endpoint: string
  readonly region?: string
  readonly account?: string
}

export interface ConnectionMetadataFormValues {
  readonly kind: ConnectionMetadataKind
  readonly name: string
  readonly endpoint: string
  readonly region: string
  readonly account: string
}

export interface TrustedTransportRequest {
  readonly kind: ConnectionMetadataKind
  readonly endpoint: string
}

/** An installed transport policy must explicitly return true for remote cleartext HTTP. */
export type TrustedTransportPolicy = (request: TrustedTransportRequest) => boolean

export interface ConnectionMetadataValidationOptions {
  readonly trustedTransportPolicy?: TrustedTransportPolicy
}

export interface ConnectionMetadataIssue {
  readonly field: ConnectionMetadataField
  readonly message: string
}

export type ConnectionMetadataValidation =
  | { readonly ok: true; readonly draft: ConnectionMetadataDraft }
  | { readonly ok: false; readonly issues: readonly ConnectionMetadataIssue[] }

const INPUT_KEYS = new Set(['kind', 'name', 'endpoint', 'region', 'account'])
const SECRET_MARKER = /\[redacted (?:secret|credential|bearer|link)\]/u

export function isConnectionMetadataKind(value: unknown): value is ConnectionMetadataKind {
  return value === 'cli-bridge' || value === 'tangle-inference' || value === 'tangle-sandbox'
}

export function connectionMetadataDraftFromForm(
  form: ConnectionMetadataFormValues,
  options: ConnectionMetadataValidationOptions = {},
): ConnectionMetadataValidation {
  return validateConnectionMetadataDraft(
    {
      kind: form.kind,
      name: form.name,
      endpoint: form.endpoint,
      ...(form.kind === 'cli-bridge'
        ? {}
        : {
            ...(form.region.trim() === '' ? {} : { region: form.region }),
            ...(form.account.trim() === '' ? {} : { account: form.account }),
          }),
    },
    options,
  )
}

export function validateConnectionMetadataDraft(
  input: unknown,
  options: ConnectionMetadataValidationOptions = {},
): ConnectionMetadataValidation {
  const issues: ConnectionMetadataIssue[] = []
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [{ field: 'metadata', message: 'Connection metadata must be an object' }],
    }
  }

  for (const key of Object.keys(input)) {
    if (INPUT_KEYS.has(key)) continue
    issues.push({
      field: isSensitiveFieldName(key) ? 'credentials' : 'metadata',
      message: isSensitiveFieldName(key)
        ? 'Credential values are not accepted here; use the masked credential component'
        : 'Only connection metadata is accepted here',
    })
  }

  const kind = input.kind
  if (!isConnectionMetadataKind(kind)) {
    issues.push({ field: 'kind', message: 'Choose a supported connection kind' })
  }

  const name = readText(input.name, 'name', issues, 120)
  const endpointInput = readText(input.endpoint, 'endpoint', issues, 2_048)
  const region = readOptionalText(input.region, 'region', issues, 128)
  const account = readOptionalText(input.account, 'account', issues, 256)
  if (!isConnectionMetadataKind(kind)) return invalid(issues)

  if (kind === 'cli-bridge' && (region !== undefined || account !== undefined)) {
    issues.push({
      field: region !== undefined ? 'region' : 'account',
      message: 'Region and account are only available for Tangle connections',
    })
  }

  let endpoint: string | undefined
  if (endpointInput !== undefined) {
    endpoint = parseSafeEndpoint(endpointInput, kind, options.trustedTransportPolicy, issues)
  }
  if (issues.length > 0 || name === undefined || endpoint === undefined) return invalid(issues)

  const draft: ConnectionMetadataDraft = Object.freeze({
    kind,
    name,
    endpoint,
    ...(kind === 'cli-bridge'
      ? {}
      : {
          ...(region === undefined ? {} : { region }),
          ...(account === undefined ? {} : { account }),
        }),
  })
  return { ok: true, draft }
}

export function connectionMetadataErrorText(issues: readonly ConnectionMetadataIssue[]): string {
  return issues.map((issue) => `${issue.field}: ${issue.message}`).join(' · ')
}

function readText(
  value: unknown,
  field: 'name' | 'endpoint',
  issues: ConnectionMetadataIssue[],
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') {
    issues.push({ field, message: 'Enter a value' })
    return undefined
  }
  const sanitized = sanitizeFieldText(value)
  if (SECRET_MARKER.test(sanitized)) {
    issues.push({
      field: 'credentials',
      message: 'Credential values are not accepted here; use the masked credential component',
    })
    return undefined
  }
  if (sanitized.length === 0) {
    issues.push({ field, message: 'Enter a value' })
    return undefined
  }
  if (sanitized.length > maxLength) {
    issues.push({ field, message: `Use at most ${maxLength} characters` })
    return undefined
  }
  return sanitized
}

function readOptionalText(
  value: unknown,
  field: 'region' | 'account',
  issues: ConnectionMetadataIssue[],
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    issues.push({ field, message: 'Enter text or leave this field empty' })
    return undefined
  }
  const sanitized = sanitizeFieldText(value)
  if (sanitized.length === 0) return undefined
  if (SECRET_MARKER.test(sanitized)) {
    issues.push({
      field: 'credentials',
      message: 'Credential values are not accepted here; use the masked credential component',
    })
    return undefined
  }
  if (sanitized.length > maxLength) {
    issues.push({ field, message: `Use at most ${maxLength} characters` })
    return undefined
  }
  return sanitized
}

function sanitizeFieldText(value: string): string {
  return sanitizeTerminalText(value)
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
}

function parseSafeEndpoint(
  endpointInput: string,
  kind: ConnectionMetadataKind,
  trustedTransportPolicy: TrustedTransportPolicy | undefined,
  issues: ConnectionMetadataIssue[],
): string | undefined {
  let url: URL
  try {
    url = new URL(endpointInput)
  } catch {
    issues.push({ field: 'endpoint', message: 'Enter a valid HTTP(S) endpoint' })
    return undefined
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    issues.push({ field: 'endpoint', message: 'Endpoint must use HTTP or HTTPS' })
    return undefined
  }
  if (url.username || url.password) {
    issues.push({ field: 'endpoint', message: 'Endpoint credentials are not accepted here' })
    return undefined
  }
  if (endpointInput.includes('?') || endpointInput.includes('#')) {
    issues.push({ field: 'endpoint', message: 'Endpoint cannot contain a query or fragment' })
    return undefined
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    const canonical = canonicalEndpoint(url)
    let permitted = false
    try {
      permitted = trustedTransportPolicy?.({ kind, endpoint: canonical }) === true
    } catch {
      permitted = false
    }
    if (!permitted) {
      issues.push({
        field: 'endpoint',
        message: 'Remote HTTP requires an explicit trusted transport policy',
      })
      return undefined
    }
  }
  return canonicalEndpoint(url)
}

function canonicalEndpoint(url: URL): string {
  const value = url.toString()
  return url.pathname === '/' && url.search === '' && url.hash === '' ? value.slice(0, -1) : value
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  const octets = normalized.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.slice(1).every((octet) => /^\d+$/u.test(octet) && Number(octet) <= 255)
  )
}

function invalid(issues: readonly ConnectionMetadataIssue[]): ConnectionMetadataValidation {
  return {
    ok: false,
    issues:
      issues.length > 0
        ? Object.freeze([...issues])
        : Object.freeze([{ field: 'metadata', message: 'Complete the connection metadata' }]),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
