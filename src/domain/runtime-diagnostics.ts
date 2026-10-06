import { SENSITIVE_DIAGNOSTIC } from './provider-values.js'
import { redactSensitiveText } from './secret-sanitizer.js'

export const BRAID_SANDBOX_INTERACTION_UNSUPPORTED =
  'BRAID_SANDBOX_INTERACTION_UNSUPPORTED' as const
export const BRAID_SANDBOX_CLEANUP_UNCONFIRMED = 'BRAID_SANDBOX_CLEANUP_UNCONFIRMED' as const

const PUBLIC_RUNTIME_DIAGNOSTICS = Object.freeze({
  [BRAID_SANDBOX_INTERACTION_UNSUPPORTED]:
    'Sandbox requested user interaction, but this ephemeral route cannot retain and resume the environment',
  [BRAID_SANDBOX_CLEANUP_UNCONFIRMED]:
    'Sandbox deletion was not acknowledged; resource state is unknown',
})

export function publicRuntimeDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Object.hasOwn(PUBLIC_RUNTIME_DIAGNOSTICS, value)) {
    return undefined
  }
  return PUBLIC_RUNTIME_DIAGNOSTICS[value as keyof typeof PUBLIC_RUNTIME_DIAGNOSTICS]
}

// Runtime's Router executor reports a non-success upstream response as
// `router <status>: <body prefix>`, either as the whole message or after a
// `<context>: transport failed: ` prefix.
const PROVIDER_HTTP_FAILURE = /(?:^|:\s)router ([45]\d{2}): ([^\n]*)/u
const PROVIDER_ERROR_OBJECT = /"error"\s*:\s*\{([^{}]*)/u
const providerErrorField = (name: string) =>
  new RegExp(String.raw`"${name}"\s*:\s*"([A-Za-z][A-Za-z0-9_.-]{0,63})"`, 'u')
const PROVIDER_ERROR_TYPE = providerErrorField('type')
const PROVIDER_ERROR_CODE = providerErrorField('code')

function providerFailureClass(status: number): string {
  if (status === 401 || status === 403) return 'RUNTIME_PROVIDER_UNAUTHORIZED'
  if (status === 402) return 'RUNTIME_PROVIDER_PAYMENT_REQUIRED'
  if (status === 404) return 'RUNTIME_PROVIDER_NOT_FOUND'
  if (status === 429) return 'RUNTIME_PROVIDER_RATE_LIMITED'
  if (status >= 500) return 'RUNTIME_PROVIDER_UNAVAILABLE'
  return 'RUNTIME_PROVIDER_REJECTED'
}

// A provider-declared token is public only when it cannot carry credential material.
function providerToken(scope: string, field: RegExp): string | undefined {
  const value = field.exec(scope)?.[1]
  if (value === undefined || value === 'error') return undefined
  if (SENSITIVE_DIAGNOSTIC.test(value) || redactSensitiveText(value) !== value) return undefined
  return value
}

/**
 * Classify a runtime failure message into a public diagnostic.
 *
 * Provider text is untrusted, so only the HTTP status and the provider's own
 * error type and code tokens survive; the free-text body never reaches state.
 * Returns undefined when the message does not carry a provider HTTP failure.
 */
export function providerHttpFailureDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = PROVIDER_HTTP_FAILURE.exec(value)
  if (match === null) return relayedRouterRefusalDiagnostic(value)
  const status = Number(match[1])
  const body = match[2] ?? ''
  const scopes = [PROVIDER_ERROR_OBJECT.exec(body)?.[1], body].filter(
    (scope): scope is string => scope !== undefined,
  )
  const token = (field: RegExp) =>
    scopes.map((scope) => providerToken(scope, field)).find((found) => found !== undefined)
  const tokens = [token(PROVIDER_ERROR_TYPE), token(PROVIDER_ERROR_CODE)]
    .filter((found): found is string => found !== undefined)
    .filter((found, index, all) => all.indexOf(found) === index)
  const detail = tokens.length === 0 ? '' : ` (${tokens.join('/')})`
  return `${providerFailureClass(status)}: provider returned HTTP ${status}${detail}`
}

// CLI runners such as opencode relay Router's refusal message but drop its HTTP
// status and error tokens. Router pairs each of these public sentences with one
// fixed status and error type/code, so the sentence alone identifies the refusal.
const RELAYED_ROUTER_REFUSALS: ReadonlyArray<
  readonly [sentence: string, status: number, tokens: string]
> = Object.freeze([
  [
    'Inference requires verified paid access.',
    402,
    'insufficient_funds/payment_required',
  ],
  [
    'Email verification is required before using paid Router access.',
    403,
    'authentication_error/email_verification_required',
  ],
  [
    'This API key is scoped to another product.',
    403,
    'authentication_error/product_scope_mismatch',
  ],
])

function relayedRouterRefusalDiagnostic(value: string): string | undefined {
  const refusal = RELAYED_ROUTER_REFUSALS.find(([sentence]) => value.includes(sentence))
  if (refusal === undefined) return undefined
  const [, status, tokens] = refusal
  return `${providerFailureClass(status)}: runner relayed Router HTTP ${status} refusal (${tokens})`
}
