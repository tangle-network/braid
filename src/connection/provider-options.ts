import { containsControlCharacters, isSecretBearingKey } from './redaction.js'
import { isAbsolute, resolve } from 'node:path'
import { harnessTypeSchema } from '@tangle-network/agent-interface'
import { cloneBoundedProfileValue, type ProfileJsonLimits } from '../profile/profile-json.js'

/**
 * Provider-owned option contracts.
 *
 * A free-form `providerOptions` record accepts `{credential: "plaintext"}` and
 * stores it, so the connection record itself becomes a secret at rest. Each
 * connection kind declares exactly which option keys it accepts and what shape
 * each one has; anything else is refused, and a key that names secret material
 * must carry a typed credential reference the store resolves later.
 */

export type ProviderOptionKind = 'string' | 'number' | 'boolean' | 'string-list' | 'credential-ref'

export interface ProviderOptionSpec {
  readonly key: string
  readonly kind: ProviderOptionKind
  readonly description: string
}

export interface ProviderOptionsSpec {
  readonly options: readonly ProviderOptionSpec[]
}

/** A `kind:id` pointer to credential material Braid never copies into a record. */
export interface ProviderCredentialOption {
  readonly kind: 'credential-ref'
  readonly reference: string
}

export class ProviderOptionError extends Error {
  readonly key: string

  constructor(key: string, message: string) {
    super(message)
    this.name = 'ProviderOptionError'
    this.key = key
  }
}

const CLI_BRIDGE_OPTIONS: ProviderOptionsSpec = Object.freeze({
  options: Object.freeze([
    Object.freeze({
      key: 'trustedTunnel',
      kind: 'boolean' as const,
      description: 'Operator-attested tunnel that terminates TLS in front of a plain-HTTP bridge',
    }),
    Object.freeze({
      key: 'workspaceRoot',
      kind: 'string' as const,
      description: 'Absolute workspace root the bridge is allowed to materialize into',
    }),
    Object.freeze({
      key: 'harnessAllowList',
      kind: 'string-list' as const,
      description: 'Runner ids this bridge may execute',
    }),
  ]),
})

const TANGLE_INFERENCE_OPTIONS: ProviderOptionsSpec = Object.freeze({
  options: Object.freeze([
    Object.freeze({
      key: 'routerBaseUrl',
      kind: 'string' as const,
      description: 'OpenAI-compatible router base URL',
    }),
    Object.freeze({
      key: 'organization',
      kind: 'string' as const,
      description: 'Tangle organization the account belongs to',
    }),
    Object.freeze({
      key: 'routerCredential',
      kind: 'credential-ref' as const,
      description: 'Credential reference for the router key',
    }),
  ]),
})

const TANGLE_SANDBOX_OPTIONS: ProviderOptionsSpec = Object.freeze({
  options: Object.freeze([
    Object.freeze({
      key: 'region',
      kind: 'string' as const,
      description: 'Requested sandbox placement region',
    }),
    Object.freeze({
      key: 'sandboxSize',
      kind: 'string' as const,
      description: 'Requested sandbox size class',
    }),
    Object.freeze({
      key: 'maxConcurrentRuns',
      kind: 'number' as const,
      description: 'Ceiling on concurrent runs this connection may hold',
    }),
    Object.freeze({
      key: 'operatorCredential',
      kind: 'credential-ref' as const,
      description: 'Credential reference for the operator API key',
    }),
  ]),
})

const SPECS: ReadonlyMap<string, ProviderOptionsSpec> = new Map([
  ['cli-bridge', CLI_BRIDGE_OPTIONS],
  ['tangle-inference', TANGLE_INFERENCE_OPTIONS],
  ['tangle-sandbox', TANGLE_SANDBOX_OPTIONS],
])

const PROVIDER_OPTIONS_LIMITS: ProfileJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 16,
  maxNodes: 4_096,
  maxStringLength: 4_096,
  maxEntries: 256,
})

/** The option contract for one connection kind. */
export function providerOptionsSpec(kind: string): ProviderOptionsSpec {
  const spec = SPECS.get(kind)
  if (spec === undefined) throw new Error(`No provider option contract exists for ${kind}`)
  return spec
}

function credentialOption(key: string, value: unknown): ProviderCredentialOption {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderOptionError(key, `providerOptions.${key} must be a credential reference`)
  }
  const candidate = value as Record<string, unknown>
  if (candidate.kind !== 'credential-ref' || typeof candidate.reference !== 'string') {
    throw new ProviderOptionError(
      key,
      `providerOptions.${key} must be {kind:"credential-ref",reference:"<kind>:<id>"}`,
    )
  }
  if (
    candidate.reference.length > 512 ||
    containsControlCharacters(candidate.reference) ||
    !/^(?:os|env|session):[^\r\n]+$/u.test(candidate.reference)
  ) {
    throw new ProviderOptionError(key, `providerOptions.${key} reference must use kind:id form`)
  }
  return Object.freeze({ kind: 'credential-ref', reference: candidate.reference })
}

function scalarOption(spec: ProviderOptionSpec, value: unknown): unknown {
  if (spec.kind === 'string') {
    if (typeof value !== 'string' || value.length > 2_048) {
      throw new ProviderOptionError(
        spec.key,
        `providerOptions.${spec.key} must be a bounded string`,
      )
    }
    if (containsControlCharacters(value)) {
      throw new ProviderOptionError(
        spec.key,
        `providerOptions.${spec.key} must not contain control characters`,
      )
    }
    if (spec.key === 'routerBaseUrl') {
      let parsed: URL
      try {
        parsed = new URL(value)
      } catch {
        throw new ProviderOptionError(
          spec.key,
          `providerOptions.${spec.key} must be a valid HTTP(S) URL`,
        )
      }
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        throw new ProviderOptionError(
          spec.key,
          `providerOptions.${spec.key} must not contain credentials, a query, or a fragment`,
        )
      }
      if (
        parsed.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)
      ) {
        throw new ProviderOptionError(
          spec.key,
          `providerOptions.${spec.key} must use HTTPS outside loopback`,
        )
      }
    }
    if (spec.key === 'workspaceRoot' && (!isAbsolute(value) || resolve(value) !== value)) {
      throw new ProviderOptionError(
        spec.key,
        `providerOptions.${spec.key} must be a normalized absolute path`,
      )
    }
    return value
  }
  if (spec.kind === 'number') {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      (spec.key === 'maxConcurrentRuns' && (value < 1 || value > 1_024))
    ) {
      throw new ProviderOptionError(
        spec.key,
        `providerOptions.${spec.key} must be a safe integer between 1 and 1024`,
      )
    }
    return value
  }
  if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new ProviderOptionError(spec.key, `providerOptions.${spec.key} must be a boolean`)
    }
    return value
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ProviderOptionError(spec.key, `providerOptions.${spec.key} must be a list of strings`)
  }
  if (
    value.some(
      (entry) => entry.length === 0 || entry.length > 512 || containsControlCharacters(entry),
    )
  ) {
    throw new ProviderOptionError(
      spec.key,
      `providerOptions.${spec.key} contains an invalid string`,
    )
  }
  if (value.length > 64) {
    throw new ProviderOptionError(spec.key, `providerOptions.${spec.key} has more than 64 entries`)
  }
  if (spec.key === 'harnessAllowList') {
    for (const runner of value) {
      if (!harnessTypeSchema.safeParse(runner).success) {
        throw new ProviderOptionError(
          spec.key,
          `providerOptions.${spec.key} contains an unknown canonical runner`,
        )
      }
    }
  }
  return Object.freeze([...(value as string[])])
}

/**
 * Validate a caller-supplied option record against the provider's contract and
 * return a frozen copy. Unknown keys and plaintext secret-named values are
 * refused; recognized credential keys keep only their opaque reference.
 */
export function validateProviderOptions(
  kind: string,
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const spec = providerOptionsSpec(kind)
  if (value === undefined) return Object.freeze({})
  let bounded: unknown
  try {
    bounded = cloneBoundedProfileValue(value, PROVIDER_OPTIONS_LIMITS)
  } catch {
    throw new ProviderOptionError(
      'providerOptions',
      'providerOptions is oversized or not JSON data',
    )
  }
  if (bounded === null || typeof bounded !== 'object' || Array.isArray(bounded)) {
    throw new ProviderOptionError('providerOptions', 'providerOptions must be an object')
  }
  const byKey = new Map(spec.options.map((option) => [option.key, option]))
  const material: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(bounded)) {
    const option = byKey.get(key)
    if (option === undefined) {
      throw new ProviderOptionError(key, `providerOptions.${key} is not declared by ${kind}`)
    }
    if (option.kind === 'credential-ref') {
      Object.defineProperty(material, key, {
        value: credentialOption(key, entry),
        enumerable: true,
      })
      continue
    }
    if (isSecretBearingKey(key)) {
      throw new ProviderOptionError(
        key,
        `providerOptions.${key} names secret material and must be declared as a credential reference`,
      )
    }
    Object.defineProperty(material, key, {
      value: scalarOption(option, entry),
      enumerable: true,
    })
  }
  return Object.freeze(material)
}

/** Every credential reference the option record points at, for lease accounting. */
export function providerOptionCredentialReferences(
  options: Readonly<Record<string, unknown>>,
): readonly string[] {
  const references: string[] = []
  for (const value of Object.values(options)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const candidate = value as Record<string, unknown>
      if (candidate.kind === 'credential-ref' && typeof candidate.reference === 'string') {
        references.push(candidate.reference)
      }
    }
  }
  return Object.freeze(references)
}

/** True when the connection declares an operator-attested trusted tunnel. */
export function hasTrustedTunnel(options: Readonly<Record<string, unknown>>): boolean {
  return options.trustedTunnel === true
}
