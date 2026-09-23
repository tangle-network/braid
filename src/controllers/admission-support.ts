import { connectionIdentityDigest } from '../connection/connections.js'
import type {
  AgentProfile,
  AgentProfileSecurityPolicy,
  AgentProfileValidationResult,
  AgentProfileValidationIssue,
} from '@tangle-network/agent-interface'
import { unsupportedProfileDimensions } from '../adapters/connections/capability-report.js'
import type {
  ConnectionCapabilitySnapshot,
  ConnectionProviderPort,
  ConnectionRecord,
} from '../connection/connections.js'
import {
  redactErrorMessage,
  redactProviderText,
  redactProviderValue,
} from '../connection/redaction.js'
import { cloneBoundedProfileValue, PROFILE_JSON_LIMITS } from '../profile/profile-json.js'
import type { EffectiveRunSelection } from '../profile/run-selection.js'
import type { ProfileSourceReference } from '../profile/profile-sources.js'
import { validateCanonicalProfile } from '../profile/profile-validation.js'
import type { VerifiedWorkspaceTrust, WorkspaceConfigEntry } from '../connection/workspace-trust.js'
import type { AdmissionValidation, AdmissionWorkspace } from './admission-contracts.js'

export { connectionIdentityDigest }

export function assertProfileDocumentBinding(
  actualDigest: string | undefined,
  expectedDigest: string,
): void {
  if (actualDigest !== expectedDigest) {
    throw new Error('The profile document changed after its source digest was recorded')
  }
}

export function workspaceRecord(
  identity: string | undefined,
  trust: VerifiedWorkspaceTrust | undefined,
  request: Readonly<Record<string, unknown>> | undefined,
): AdmissionWorkspace {
  const selectedIdentity = trust?.record.identity.root ?? identity
  const safeIdentity =
    selectedIdentity === undefined ? undefined : redactProviderText(selectedIdentity, 1_024)
  let safeRequest: unknown
  if (request !== undefined) {
    const boundedRequest = cloneBoundedProfileValue(request, PROFILE_JSON_LIMITS)
    safeRequest = redactProviderValue(boundedRequest)
  }
  return Object.freeze({
    ...(safeIdentity === undefined ? {} : { identity: safeIdentity }),
    ...(trust === undefined
      ? {}
      : {
          trust: Object.freeze({
            configurationDigest: trust.record.configurationDigest,
            approvedAt: trust.record.approvedAt,
            capabilities: Object.freeze([...trust.record.capabilities]),
          }),
        }),
    ...(safeRequest === undefined || safeRequest === null || Array.isArray(safeRequest)
      ? {}
      : { request: safeRequest as Readonly<Record<string, unknown>> }),
  })
}

export function requiredWorkspaceCapabilities(
  profile: Readonly<AgentProfile>,
  securityPolicy: AgentProfileSecurityPolicy | undefined,
  request: Readonly<Record<string, unknown>> | undefined,
  sourceKind?: ProfileSourceReference['kind'],
): readonly WorkspaceConfigEntry['capabilities'][number][] {
  const required = new Set<WorkspaceConfigEntry['capabilities'][number]>()
  if (request !== undefined) required.add('project-config')
  // A configured profile is selected by project-controlled configuration and
  // cannot become active until that source itself is approved.
  if (sourceKind === 'configured') required.add('profile-source')
  if (securityPolicy?.allowHooks === true || profile.hooks !== undefined) required.add('hook')
  if (securityPolicy?.allowLocalMcp === true || profile.mcp !== undefined) {
    required.add('local-mcp')
  }
  const resources = profile.resources
  const hasResourceDestination =
    resources !== undefined &&
    ((resources.files?.length ?? 0) > 0 ||
      (resources.tools?.length ?? 0) > 0 ||
      (resources.skills?.length ?? 0) > 0 ||
      (resources.agents?.length ?? 0) > 0 ||
      (resources.commands?.length ?? 0) > 0 ||
      resources.instructions !== undefined)
  if (hasResourceDestination) required.add('resource-write')
  return Object.freeze([...required])
}

export function requiresWorkspaceTrust(
  profile: Readonly<AgentProfile>,
  securityPolicy: AgentProfileSecurityPolicy | undefined,
  request: Readonly<Record<string, unknown>> | undefined,
  sourceKind?: ProfileSourceReference['kind'],
): boolean {
  return requiredWorkspaceCapabilities(profile, securityPolicy, request, sourceKind).length > 0
}

/** Keep source metadata useful for a receipt without allowing it to become a
 * provider-controlled secret or terminal-control channel. */
export function safeProfileSource(source: ProfileSourceReference): ProfileSourceReference {
  const value = redactProviderText(source.value, 512) ?? '<profile source>'
  const label = redactProviderText(source.label, 256) ?? 'profile source'
  const revision =
    source.revision === undefined ? undefined : redactProviderText(source.revision, 256)
  return Object.freeze({
    kind: source.kind,
    value,
    label,
    ...(revision === undefined ? {} : { revision }),
    writable: source.writable,
  })
}

function safeValidationIssue(issue: AgentProfileValidationIssue): AgentProfileValidationIssue {
  const level =
    issue.level === 'error' || issue.level === 'warning' || issue.level === 'info'
      ? issue.level
      : 'error'
  const code = redactProviderText(issue.code, 128) ?? 'PROFILE_VALIDATION'
  const message = redactProviderText(issue.message, 512) ?? 'Profile validation failed'
  const path = typeof issue.path === 'string' ? redactProviderText(issue.path, 256) : undefined
  return {
    level,
    code,
    message,
    ...(path === undefined ? {} : { path }),
  }
}

export async function validateAdmissionProfile(input: {
  readonly provider: ConnectionProviderPort
  readonly connection: ConnectionRecord
  readonly selection: EffectiveRunSelection
  readonly capabilities: ConnectionCapabilitySnapshot
  readonly signal?: AbortSignal
  readonly securityPolicy?: AgentProfileSecurityPolicy
  readonly acceptedWarningCodes?: readonly string[]
  readonly acceptNormalizedProfile?: boolean
  readonly sourceKind?: ProfileSourceReference['kind']
}): Promise<AdmissionValidation> {
  const capabilityIssues: AgentProfileValidationIssue[] = unsupportedProfileDimensions(
    input.capabilities.environment.profile,
    input.selection.profile,
    { providerCatalogReference: input.sourceKind === 'provider-catalog' },
  ).map((dimension) => ({
    level: 'error' as const,
    code: 'UNSUPPORTED_PROFILE_DIMENSION',
    message: `The ${input.provider.kind} connection does not report support for ${dimension}`,
    path: dimension,
  }))
  let providerValidation: AgentProfileValidationResult
  try {
    providerValidation = input.provider.validateProfile
      ? await input.provider.validateProfile(input.connection, input.selection.profile, {
          capabilities: input.capabilities,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      : { ok: true, issues: [] as AgentProfileValidationIssue[] }
  } catch (error) {
    throw new Error(redactErrorMessage(error))
  }
  const allIssues = [
    ...validateCanonicalProfile(
      input.selection.profile,
      input.securityPolicy === undefined ? {} : { securityPolicy: input.securityPolicy },
    ).issues,
    ...capabilityIssues,
    ...providerValidation.issues,
  ]
    .map(safeValidationIssue)
    .filter(
      (issue, index, issues) =>
        issues.findIndex(
          (candidate) =>
            candidate.level === issue.level &&
            candidate.code === issue.code &&
            candidate.path === issue.path &&
            candidate.message === issue.message,
        ) === index,
    )
  const errorIssues = allIssues.filter((issue) => issue.level === 'error')
  if (errorIssues.length > 0 || !providerValidation.ok) {
    throw new Error(
      allIssues
        .map((issue) => redactProviderText(`${issue.code}: ${issue.message}`) ?? issue.code)
        .join('; '),
    )
  }
  let normalizedProfile: Readonly<AgentProfile> | undefined
  let normalizedProfileDigest: string | undefined
  if (providerValidation.normalizedProfile !== undefined) {
    const normalized = validateCanonicalProfile(
      providerValidation.normalizedProfile,
      input.securityPolicy === undefined ? {} : { securityPolicy: input.securityPolicy },
    )
    if (!normalized.ok || normalized.profile === undefined || normalized.digest === undefined) {
      throw new Error(
        normalized.issues
          .map((issue) => redactErrorMessage(`${issue.code}: ${issue.message}`))
          .join('; '),
      )
    }
    normalizedProfile = normalized.profile
    normalizedProfileDigest = normalized.digest
  }
  const accepted = Object.freeze(
    (input.acceptedWarningCodes ?? []).map((code) => {
      if (typeof code !== 'string') throw new Error('Warning codes must be strings')
      return redactProviderText(code, 128) ?? 'warning'
    }),
  )
  const unaccepted = allIssues
    .filter((issue) => issue.level === 'warning')
    .filter((issue) => !accepted.includes(issue.code))
  if (unaccepted.length > 0) {
    throw new Error(
      `Warnings require confirmation: ${unaccepted
        .map((issue) => redactProviderText(issue.code, 128) ?? 'warning')
        .join(', ')}`,
    )
  }
  if (input.acceptNormalizedProfile === true && normalizedProfile === undefined) {
    throw new Error('The provider returned no normalized profile to accept')
  }
  return Object.freeze({
    issues: Object.freeze(allIssues),
    acceptedWarningCodes: accepted,
    ...(normalizedProfile === undefined ? {} : { normalizedProfile }),
    ...(normalizedProfileDigest === undefined ? {} : { normalizedProfileDigest }),
    normalizedProfileAccepted:
      input.acceptNormalizedProfile === true && normalizedProfile !== undefined,
  })
}
