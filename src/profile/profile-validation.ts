import {
  type AgentProfile,
  type AgentProfileSecurityPolicy,
  type AgentProfileValidationIssue,
  agentProfileSchema,
  canonicalAgentProfileDigest,
  snapshotAgentProfile,
  validateAgentProfileSecurity,
} from '@tangle-network/agent-interface'
import { redactErrorMessage } from '../connection/redaction.js'
import { canonicalJson } from '../domain/canonical.js'
import { type ProfileSchemaIdentity, profileSchemaIdentity } from './profile-schema-identity.js'
import {
  cloneBoundedProfileValue,
  PROFILE_JSON_LIMITS,
  type ProfileJsonLimits,
} from './profile-json.js'

export interface ProfileValidationReport {
  readonly ok: boolean
  readonly profile?: Readonly<AgentProfile>
  readonly digest?: string
  /**
   * The exact RFC 8785 bytes the canonical package hashes for `digest`. Reported
   * from the canonical serializer rather than a local one, so a reviewer diffing
   * this string against a provider's canonical JSON sees the same ordering.
   */
  readonly canonicalJson?: string
  readonly schema?: ProfileSchemaIdentity
  /**
   * Dotted paths the installed schema does not recognize. A caller uses this to
   * tell version skew (a newer canonical field) apart from an invalid profile.
   */
  readonly unrecognizedFields: readonly string[]
  readonly issues: readonly AgentProfileValidationIssue[]
}

function issueFromError(error: unknown): AgentProfileValidationIssue {
  return {
    level: 'error',
    code: 'INVALID_PROFILE',
    message: redactErrorMessage(error),
  }
}

interface UnrecognizedKeysIssue {
  readonly code: string
  readonly keys?: readonly string[]
  readonly path: readonly (string | number | symbol)[]
}

export function boundedProfileSecurityPolicy(
  policy: AgentProfileSecurityPolicy | undefined,
  limits: ProfileJsonLimits = PROFILE_JSON_LIMITS,
): AgentProfileSecurityPolicy | undefined {
  if (policy === undefined) return undefined
  return cloneBoundedProfileValue(policy, limits) as AgentProfileSecurityPolicy
}

/**
 * Read the structured unrecognized-key list Zod reports. Parsing the message text
 * instead would break the moment the schema package changes its wording.
 */
function unrecognizedPaths(issue: UnrecognizedKeysIssue): readonly string[] {
  if (issue.code !== 'unrecognized_keys' || issue.keys === undefined) return []
  const parent = issue.path.map(String).join('.')
  return issue.keys.map((key) => (parent === '' ? key : `${parent}.${key}`))
}

export function validateCanonicalProfile(
  value: unknown,
  options: {
    readonly securityPolicy?: AgentProfileSecurityPolicy
    readonly limits?: ProfileJsonLimits
  } = {},
): ProfileValidationReport {
  let bounded: unknown
  let securityPolicy: AgentProfileSecurityPolicy | undefined
  try {
    const limits = options.limits ?? PROFILE_JSON_LIMITS
    bounded = cloneBoundedProfileValue(value, limits)
    securityPolicy = boundedProfileSecurityPolicy(options.securityPolicy, limits)
  } catch (error) {
    return Object.freeze({
      ok: false,
      unrecognizedFields: Object.freeze([]),
      issues: Object.freeze([
        {
          level: 'error' as const,
          code: 'PROFILE_INPUT_LIMIT',
          message: redactErrorMessage(error),
        },
      ]),
    })
  }
  const parsed = agentProfileSchema.safeParse(bounded)
  if (!parsed.success) {
    const unrecognized = parsed.error.issues.flatMap((issue) =>
      unrecognizedPaths(issue as unknown as UnrecognizedKeysIssue),
    )
    return Object.freeze({
      ok: false,
      unrecognizedFields: Object.freeze([...new Set(unrecognized)]),
      issues: Object.freeze(
        parsed.error.issues.map((issue) => ({
          level: 'error' as const,
          code:
            issue.code === 'unrecognized_keys' ? 'UNRECOGNIZED_PROFILE_FIELD' : 'INVALID_PROFILE',
          message: issue.message,
          path: issue.path.map(String).join('.'),
        })),
      ),
    })
  }

  try {
    const profile = snapshotAgentProfile(parsed.data)
    const security = validateAgentProfileSecurity(profile, securityPolicy)
    return Object.freeze({
      ok: security.ok,
      profile,
      digest: canonicalAgentProfileDigest(profile),
      canonicalJson: canonicalJson(profile),
      schema: profileSchemaIdentity(),
      unrecognizedFields: Object.freeze([]),
      issues: Object.freeze([...security.issues]),
    })
  } catch (error) {
    return Object.freeze({
      ok: false,
      unrecognizedFields: Object.freeze([]),
      issues: Object.freeze([issueFromError(error)]),
    })
  }
}

export function requireCanonicalProfile(
  value: unknown,
  options: { readonly securityPolicy?: AgentProfileSecurityPolicy } = {},
): Readonly<AgentProfile> {
  const report = validateCanonicalProfile(value, options)
  if (!report.ok || report.profile === undefined) {
    const detail = report.issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ')
    throw new Error(`Profile validation failed${detail ? `: ${detail}` : ''}`)
  }
  return report.profile
}
