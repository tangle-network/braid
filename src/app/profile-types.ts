import type {
  AgentProfile,
  AgentProfileCapabilities,
  AgentProfileRef,
  AgentProfileSecurityPolicy,
  AgentProfileValidationIssue,
  AgentProfileValidationResult,
  HarnessType,
  ReasoningEffort,
  Sha256Digest,
} from '@tangle-network/agent-interface'
import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface/environment-provider'

export const PROFILE_EXPORT_FORMAT = 'braid-agent-profile' as const
export const PROFILE_EXPORT_SCHEMA_VERSION = 1 as const

export type ProfileSourceKind = 'inline' | 'file' | 'provider' | 'package' | 'github' | 'recent'

export interface ProfileSourceDescriptor {
  readonly kind: ProfileSourceKind
  readonly reference: string
  readonly label: string
  readonly revision?: string
  readonly writable: boolean
  readonly trusted: boolean
}

export interface ProfileSourceRecord {
  readonly source: ProfileSourceDescriptor
  readonly profile: Readonly<AgentProfile>
  readonly digest: Sha256Digest
  readonly agentInterfacePackageVersion: string
}

export interface ProfileSourceResolverContext {
  readonly signal?: AbortSignal
  readonly workspaceRoot?: string
}

export type ProfileSourceResolver = (
  reference: string,
  context: ProfileSourceResolverContext,
) => Promise<AgentProfile | ProfileSourceResolution>

export interface ProfileSourceResolution {
  readonly profile: AgentProfile
  readonly revision?: string
  readonly writable?: boolean
}

interface ProfileSourceSpecBase {
  readonly reference: string
  readonly label?: string
  readonly revision?: string
  readonly writable?: boolean
  readonly trusted?: boolean
}

export interface InlineProfileSourceSpec extends ProfileSourceSpecBase {
  readonly kind: 'inline'
  readonly profile: AgentProfile
}

export interface FileProfileSourceSpec extends ProfileSourceSpecBase {
  readonly kind: 'file'
  readonly path: string
}

export interface ResolvedProfileSourceSpec extends ProfileSourceSpecBase {
  readonly kind: 'provider' | 'package' | 'github' | 'recent'
  readonly resolve: ProfileSourceResolver
}

export type ProfileSourceSpec =
  | InlineProfileSourceSpec
  | FileProfileSourceSpec
  | ResolvedProfileSourceSpec

export interface ProfileRecord extends ProfileSourceRecord {
  readonly id: string
  readonly displayName: string
}

export type ProfileIssueOrigin = 'schema' | 'security' | 'provider' | 'source'

export interface ProfileIssue extends AgentProfileValidationIssue {
  readonly origin: ProfileIssueOrigin
  readonly path?: string
}

export interface ProfileProviderValidation {
  readonly provider: string
  readonly result: AgentProfileValidationResult
  readonly capabilities?: AgentProfileCapabilities
}

export interface ProfileValidationReport {
  readonly ok: boolean
  readonly issues: readonly ProfileIssue[]
  readonly profile?: Readonly<AgentProfile>
  readonly digest?: Sha256Digest
  readonly provider?: ProfileProviderValidation
  readonly acceptedProviderWarningCodes?: readonly string[]
}

export interface ProfileValidationOptions {
  readonly securityPolicy?: AgentProfileSecurityPolicy
  readonly provider?: ProfileProvider
  readonly acceptedProviderWarningCodes?: readonly string[]
  readonly signal?: AbortSignal
}

/** The narrow provider surface needed to validate a portable profile. */
export interface ProfileProvider {
  readonly name: string
  readonly capabilities?: () => AgentEnvironmentCapabilities | Promise<AgentEnvironmentCapabilities>
  readonly validateProfile?: (
    profile: AgentProfileRef,
  ) => AgentProfileValidationResult | Promise<AgentProfileValidationResult>
}

export interface ProfileDiscoveryInput {
  readonly explicit?: readonly ProfileSourceSpec[]
  readonly workspace?: readonly ProfileSourceSpec[]
  readonly workspaceTrusted?: boolean
  readonly user?: readonly ProfileSourceSpec[]
  readonly provider?: readonly ProfileSourceSpec[]
  readonly recent?: readonly ProfileSourceSpec[]
  readonly resolverContext?: ProfileSourceResolverContext
}

export interface ProfileDiscoveryIssue {
  readonly source: ProfileSourceDescriptor
  readonly issue: ProfileIssue
}

export interface ProfileDiscoveryResult {
  readonly profiles: readonly ProfileRecord[]
  readonly issues: readonly ProfileDiscoveryIssue[]
}

export interface ProfileSelectionCandidates {
  readonly commandLine?: ProfileRecord
  readonly branch?: ProfileRecord
  readonly workspace?: ProfileRecord
  readonly user?: ProfileRecord
  readonly firstRun?: ProfileRecord
  readonly workspaceTrusted?: boolean
}

export type ProfileSelectionReason = 'command-line' | 'branch' | 'workspace' | 'user' | 'first-run'

export interface ProfileSelectionResult {
  readonly profile: ProfileRecord
  readonly reason: ProfileSelectionReason
}

export interface ProfileRunOverrides {
  readonly harness?: HarnessType
  readonly model?: string
  readonly effort?: ReasoningEffort
  readonly mode?: string
  readonly connectionId?: string
}

export interface EffectiveProfileInput {
  readonly profile: ProfileRecord
  readonly branchOverrides?: ProfileRunOverrides
  readonly nextRunOverrides?: ProfileRunOverrides
  readonly workspaceTrusted?: boolean
  readonly workspaceConnectionId?: string
  readonly userConnectionId?: string
  readonly availableModelIds?: readonly string[]
  readonly modelReasoning?: {
    readonly supportsReasoning?: boolean
    readonly maxEffort?: ReasoningEffort
  }
}

export interface EffectiveProfileResult {
  readonly authoredProfile: Readonly<AgentProfile>
  readonly effectiveProfile: Readonly<AgentProfile>
  readonly runner?: HarnessType
  readonly model?: string
  readonly effort?: ReasoningEffort
  readonly mode?: string
  readonly connectionId?: string
  readonly overrides: Readonly<ProfileRunOverrides>
  readonly compatibility: ProfileCompatibility
}

export interface ProfileCompatibility {
  readonly modelSupported?: boolean
  readonly suggestedModel?: string
  readonly suggestedRunner?: HarnessType
  readonly modelHonored?: boolean
  readonly effortHonored?: boolean
  readonly selectorsHonored?: boolean
  readonly availableEfforts?: readonly ReasoningEffort[]
}

export interface ProfileDraftValidation {
  readonly ok: boolean
  readonly issues: readonly ProfileIssue[]
  readonly profile?: Readonly<AgentProfile>
  readonly digest?: Sha256Digest
}

export interface ProfileExportDocument {
  readonly format: typeof PROFILE_EXPORT_FORMAT
  readonly schemaVersion: typeof PROFILE_EXPORT_SCHEMA_VERSION
  readonly agentInterfacePackage: {
    readonly name: '@tangle-network/agent-interface'
    readonly version: string
  }
  /** Digest of the profile before export redaction. */
  readonly sourceProfileDigest: Sha256Digest
  /** Digest of the exact profile carried in this document. */
  readonly profileDigest: Sha256Digest
  readonly redacted: boolean
  readonly profile: Readonly<AgentProfile>
}

export interface ImportedProfileDocument {
  readonly profile: Readonly<AgentProfile>
  readonly digest: Sha256Digest
  readonly redacted: boolean
  readonly sourceProfileDigest?: Sha256Digest
  readonly packageVersion: string
}

export interface ProfileExportOptions {
  readonly redact?: boolean
  readonly pretty?: boolean
}

export interface ProfileImportOptions {
  readonly allowRedacted?: boolean
}

export interface ProfileFileState {
  readonly path: string
  readonly bytesDigest: Sha256Digest
  readonly record: ProfileRecord
}

export interface SaveProfileFileOptions {
  readonly expectedBytesDigest?: Sha256Digest
  readonly expectedProfileDigest?: Sha256Digest
  readonly expectedBytesAbsent?: boolean
  readonly overwrite?: boolean
  readonly sourceLabel?: string
  readonly trusted?: boolean
  readonly onPhase?: (phase: ProfileFileWritePhase) => void
}

export type ProfileFileWritePhase =
  | 'temporary-written'
  | 'temporary-fsynced'
  | 'renamed'
  | 'directory-fsynced'

export interface ExportProfileFileOptions extends SaveProfileFileOptions, ProfileExportOptions {}

export interface ProfileSnapshotInput {
  readonly source: ProfileRecord
  readonly effective: EffectiveProfileResult
  readonly validation: ProfileValidationReport
  readonly capabilities?: AgentProfileCapabilities
  readonly providerMaterializationReceipt?: unknown
}

export interface ProfileSnapshotReceipt {
  readonly kind: 'braid-profile-snapshot'
  readonly schemaVersion: 1
  readonly agentInterfacePackage: {
    readonly name: '@tangle-network/agent-interface'
    readonly version: string
  }
  readonly source: ProfileSourceDescriptor
  readonly authoredProfile: Readonly<AgentProfile>
  readonly effectiveProfile: Readonly<AgentProfile>
  readonly authoredProfileDigest: Sha256Digest
  readonly effectiveProfileDigest: Sha256Digest
  readonly runner?: HarnessType
  readonly model?: string
  readonly effort?: ReasoningEffort
  readonly mode?: string
  readonly connectionId?: string
  readonly overrides: Readonly<ProfileRunOverrides>
  readonly validation: {
    readonly ok: boolean
    readonly issues: readonly ProfileIssue[]
    readonly acceptedProviderWarningCodes?: readonly string[]
  }
  readonly capabilities?: AgentProfileCapabilities
  readonly providerMaterializationReceipt?: unknown
  readonly digest: Sha256Digest
}
