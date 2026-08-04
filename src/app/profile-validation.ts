import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import {
  AgentEnvironmentCapabilitiesSchema,
  type AgentProfile,
  type AgentProfileCapabilities,
  type AgentProfileSecurityPolicy,
  type AgentProfileValidationResult,
  agentProfileSchema,
  canonicalAgentProfileDigest,
  DEFAULT_CLOUD_AGENT_PROFILE_SECURITY_POLICY,
  snapshotAgentProfile,
  validateAgentProfileSecurity,
} from '@tangle-network/agent-interface'
import { redactSensitiveText } from '../domain/secret-sanitizer.js'
import type {
  ProfileIssue,
  ProfileProvider,
  ProfileProviderValidation,
  ProfileValidationOptions,
  ProfileValidationReport,
} from './profile-types.js'

const require = createRequire(import.meta.url)

export const AGENT_INTERFACE_PACKAGE_NAME = '@tangle-network/agent-interface' as const
export const AGENT_INTERFACE_PACKAGE_VERSION = readAgentInterfaceVersion()

function readAgentInterfaceVersion(): string {
  try {
    const entry = require.resolve(AGENT_INTERFACE_PACKAGE_NAME)
    const packagePath = join(dirname(entry), '..', 'package.json')
    const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'))
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      typeof parsed.version === 'string' &&
      parsed.version.length > 0
    ) {
      return parsed.version
    }
  } catch {
    // The published package normally has package metadata beside its entrypoint.
  }
  return 'unavailable'
}

function pathText(path: readonly PropertyKey[]): string | undefined {
  if (path.length === 0) return undefined
  return path.map((part) => (typeof part === 'symbol' ? part.toString() : String(part))).join('.')
}

function issue(
  origin: ProfileIssue['origin'],
  level: ProfileIssue['level'],
  code: string,
  message: string,
  path?: string,
): ProfileIssue {
  return {
    origin,
    level,
    code: redactSensitiveText(code, 256),
    message: redactSensitiveText(message, 4096),
    ...(path === undefined ? {} : { path: redactSensitiveText(path, 512) }),
  }
}

function schemaIssues(error: {
  readonly issues: readonly { path: PropertyKey[]; code: string; message: string }[]
}): ProfileIssue[] {
  return error.issues.map((item) =>
    issue('schema', 'error', item.code, item.message, pathText(item.path)),
  )
}

function securityIssues(profile: AgentProfile, policy: AgentProfileSecurityPolicy): ProfileIssue[] {
  const result = validateAgentProfileSecurity(profile, policy)
  return result.issues.map((item) =>
    issue('security', item.level, item.code, item.message, item.path),
  )
}

const INLINE_SECRET_FIELD =
  /^(?:api(?:key|token)|access(?:key|token)|privatekey|clientsecret|token|secret|password|passphrase|credential|authorization|cookie|databaseurl|dsn|pat)$/u

function inlineSecretIssues(profile: AgentProfile): ProfileIssue[] {
  const issues: ProfileIssue[] = []
  const visit = (value: unknown, path: readonly PropertyKey[]): void => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        visit(child, [...path, index])
      })
      return
    }
    for (const [name, child] of Object.entries(value)) {
      const childPath = [...path, name]
      const normalized = name.replace(/[^a-z0-9]/giu, '').toLowerCase()
      if (INLINE_SECRET_FIELD.test(normalized) && !isSecretReference(child)) {
        issues.push(
          issue(
            'security',
            'error',
            'inline-secret-forbidden',
            'Inline credential material must use a protected secret reference',
            pathText(childPath),
          ),
        )
      }
      visit(child, childPath)
    }
  }
  visit(profile, [])
  return issues
}

function isSecretReference(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return (
    'kind' in value &&
    value.kind === 'secret-ref' &&
    'key' in value &&
    typeof value.key === 'string' &&
    value.key.length > 0
  )
}

function safeProviderResult(value: AgentProfileValidationResult): AgentProfileValidationResult {
  return {
    ok: value.ok,
    issues: value.issues.map((item) => ({
      level: item.level,
      code: redactSensitiveText(item.code, 256),
      message: redactSensitiveText(item.message, 4096),
      ...(item.path === undefined ? {} : { path: redactSensitiveText(item.path, 512) }),
    })),
    ...(value.normalizedProfile === undefined
      ? {}
      : { normalizedProfile: value.normalizedProfile }),
  }
}

export function validateProfileShape(value: unknown): ProfileValidationReport {
  try {
    const parsed = agentProfileSchema.safeParse(value)
    if (!parsed.success) {
      return { ok: false, issues: schemaIssues(parsed.error) }
    }
    const profile = snapshotAgentProfile(parsed.data)
    return {
      ok: true,
      issues: [],
      profile,
      digest: canonicalAgentProfileDigest(profile),
    }
  } catch (error) {
    return {
      ok: false,
      issues: [
        issue(
          'schema',
          'error',
          'profile-snapshot-failed',
          error instanceof Error ? error.message : String(error),
        ),
      ],
    }
  }
}

function providerIssues(
  provider: ProfileProvider,
  result: AgentProfileValidationResult,
  acceptedWarnings: ReadonlySet<string>,
): ProfileIssue[] {
  const output: ProfileIssue[] = []
  const safe = safeProviderResult(result)
  for (const item of safe.issues) {
    output.push(issue('provider', item.level, item.code, item.message, item.path))
    if (item.level === 'warning' && !acceptedWarnings.has(item.code)) {
      output.push(
        issue(
          'provider',
          'error',
          'provider-warning-not-accepted',
          `Provider warning ${item.code} requires explicit acceptance`,
          item.path,
        ),
      )
    }
  }
  if (!safe.ok && safe.issues.every((item) => item.level !== 'error')) {
    if (safe.issues.length === 0) {
      output.push(
        issue(
          'provider',
          'error',
          'provider-rejected-profile',
          `Provider ${provider.name} rejected the profile without an issue`,
        ),
      )
    }
  }
  return output
}

async function providerCapabilities(
  provider: ProfileProvider,
): Promise<{ readonly value?: AgentProfileCapabilities; readonly issues: ProfileIssue[] }> {
  if (provider.capabilities === undefined) return { issues: [] }
  try {
    const candidate = await provider.capabilities()
    const parsed = AgentEnvironmentCapabilitiesSchema.safeParse(candidate)
    if (!parsed.success) {
      return {
        issues: [
          issue(
            'provider',
            'error',
            'invalid-provider-capabilities',
            'Provider returned capabilities that do not match the canonical environment contract',
          ),
        ],
      }
    }
    const value = parsed.data.profile
    return {
      value: {
        namedProfiles: value.namedProfiles,
        systemPrompt: value.systemPrompt,
        instructions: value.instructions,
        tools: value.tools,
        permissions: value.permissions,
        mcp: value.mcp,
        subagents: value.subagents,
        resources: {
          files: value.resources.files,
          instructions: value.resources.instructions,
          ...(value.resources.tools === undefined ? {} : { tools: value.resources.tools }),
          ...(value.resources.skills === undefined ? {} : { skills: value.resources.skills }),
          ...(value.resources.agents === undefined ? {} : { agents: value.resources.agents }),
          ...(value.resources.commands === undefined ? {} : { commands: value.resources.commands }),
        },
        ...(value.hooks === undefined ? {} : { hooks: value.hooks }),
        ...(value.modes === undefined ? {} : { modes: value.modes }),
        runtimeUpdate: value.runtimeUpdate,
        validation: value.validation,
        ...(value.extensions === undefined ? {} : { extensions: value.extensions }),
      },
      issues: [],
    }
  } catch (error) {
    return {
      issues: [
        issue(
          'provider',
          'error',
          'provider-capabilities-failed',
          error instanceof Error ? error.message : String(error),
        ),
      ],
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Profile validation was aborted', 'AbortError')
}

/**
 * Validate one profile at the application boundary.
 *
 * The schema, security policy, provider validation, and provider normalization
 * are all applied in order; Braid never drops a field to make a provider accept
 * a profile.
 */
export async function validateProfile(
  value: unknown,
  options: ProfileValidationOptions = {},
): Promise<ProfileValidationReport> {
  throwIfAborted(options.signal)
  const shape = validateProfileShape(value)
  if (!shape.ok || shape.profile === undefined) return shape

  const securityPolicy = options.securityPolicy ?? DEFAULT_CLOUD_AGENT_PROFILE_SECURITY_POLICY
  const issues = [
    ...securityIssues(shape.profile, securityPolicy),
    ...inlineSecretIssues(shape.profile),
  ]
  let profile = shape.profile
  let capabilities: AgentProfileCapabilities | undefined
  let providerReport: ProfileProviderValidation | undefined
  const acceptedWarningCodes = new Set(options.acceptedProviderWarningCodes ?? [])

  if (options.provider !== undefined) {
    const provider = options.provider
    const capabilityResult = await providerCapabilities(provider)
    issues.push(...capabilityResult.issues)
    capabilities = capabilityResult.value
    throwIfAborted(options.signal)

    if (provider.validateProfile === undefined) {
      const validates = capabilities?.validation
      if (validates === true) {
        issues.push(
          issue(
            'provider',
            'error',
            'provider-validation-unavailable',
            `Provider ${provider.name} advertises profile validation but exposes no validator`,
          ),
        )
      } else {
        issues.push(
          issue(
            'provider',
            'info',
            'provider-validation-unavailable',
            `Provider ${provider.name} does not expose profile validation`,
          ),
        )
      }
    } else {
      let result: AgentProfileValidationResult
      try {
        result = await provider.validateProfile(profile)
      } catch (error) {
        result = {
          ok: false,
          issues: [
            {
              level: 'error',
              code: 'provider-validation-failed',
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        }
      }
      const safe = safeProviderResult(result)
      providerReport = {
        provider: redactSensitiveText(provider.name, 256),
        result: safe,
        ...(capabilities === undefined ? {} : { capabilities }),
      }
      issues.push(...providerIssues(provider, safe, acceptedWarningCodes))
      if (safe.normalizedProfile !== undefined && issues.every((item) => item.level !== 'error')) {
        const normalized = validateProfileShape(safe.normalizedProfile)
        if (!normalized.ok || normalized.profile === undefined) {
          issues.push(
            issue(
              'provider',
              'error',
              'invalid-provider-normalization',
              'Provider normalization did not produce a canonical AgentProfile',
            ),
          )
        } else {
          profile = normalized.profile
          issues.push(...securityIssues(profile, securityPolicy))
        }
      }
    }
  }

  const ok = issues.every((item) => item.level !== 'error')
  return {
    ok,
    issues,
    profile,
    digest: canonicalAgentProfileDigest(profile),
    ...(providerReport === undefined ? {} : { provider: providerReport }),
    ...(acceptedWarningCodes.size === 0
      ? {}
      : {
          acceptedProviderWarningCodes: [...acceptedWarningCodes]
            .map((code) => redactSensitiveText(code, 256))
            .sort(),
        }),
  }
}

export function assertValidProfile(
  value: unknown,
  options: { readonly securityPolicy?: AgentProfileSecurityPolicy } = {},
): Readonly<AgentProfile> {
  const shape = validateProfileShape(value)
  if (!shape.ok || shape.profile === undefined) {
    throw new ProfileValidationError(shape.issues)
  }
  const issues = securityIssues(
    shape.profile,
    options.securityPolicy ?? DEFAULT_CLOUD_AGENT_PROFILE_SECURITY_POLICY,
  )
  const errors = issues.filter((item) => item.level === 'error')
  if (errors.length > 0) throw new ProfileValidationError(errors)
  return shape.profile
}

export class ProfileValidationError extends Error {
  readonly issues: readonly ProfileIssue[]

  constructor(issues: readonly ProfileIssue[]) {
    super(issues.map((item) => `${item.path ?? '$'}: ${item.message}`).join('; '))
    this.name = 'ProfileValidationError'
    this.issues = issues
  }
}
