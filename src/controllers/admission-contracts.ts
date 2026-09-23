import type {
  AgentEnvironmentCapabilities,
  AgentProfile,
  AgentProfileValidationIssue,
} from '@tangle-network/agent-interface'
import type { ConnectionCapabilitySnapshot, ConnectionRecord } from '../connection/connections.js'
import type {
  WorkspaceConfigEntry,
  WorkspaceInspectionFile,
  WorkspaceIdentity,
  WorkspaceTrustRecord,
} from '../connection/workspace-trust.js'
import type { ProfileDocument } from '../profile/profile-sources.js'
import type { ProfileSchemaIdentity } from '../profile/profile-schema-identity.js'
import type { EffectiveRunSelection, RunOverrides } from '../profile/run-selection.js'
import { redactProviderText } from '../connection/redaction.js'
import { canonicalDigest } from '../domain/canonical.js'
import {
  assertPostMatchesPre,
  normalizeStoredPostMaterialization,
  normalizeStoredPreAdmission,
} from './receipt-store-validation.js'
import { publicCapabilitySnapshotDigest } from './public-capabilities.js'

export interface RunIdentifiers {
  readonly operationId: string
  readonly turnId: string
  readonly branchId: string
  readonly conversationId: string
}

/** The verified trust facts an admission is allowed to record. */
export interface AdmissionWorkspace {
  readonly identity?: string
  readonly trust?: Readonly<{
    readonly configurationDigest: string
    readonly approvedAt: string
    readonly capabilities: readonly WorkspaceConfigEntry['capabilities'][number][]
  }>
  readonly request?: Readonly<Record<string, unknown>>
}

export interface ProviderMaterializationPath {
  readonly path: string
  readonly mode?: number
  readonly digest?: string
}

export interface ProviderMaterializationReceipt {
  readonly materializationDigest: string
  /** Digest of the effective profile the runtime actually materialized. */
  readonly effectiveProfileDigest: string
  /** The request digest the runtime was admitted with. */
  readonly requestDigest: string
  /** Digest of the capability snapshot used for preparation and dispatch. */
  readonly capabilityDigest: string
  readonly generatedPaths: readonly ProviderMaterializationPath[]
  readonly unsupportedDimensions: readonly string[]
  readonly normalizedValues: Readonly<Record<string, unknown>>
  readonly providerVersion?: string
  readonly runnerVersion?: string
  readonly runtimeRunId?: string
  readonly providerSessionId?: string
  readonly environmentId?: string
  readonly placement?: Readonly<Record<string, unknown>>
  readonly replayCursor?: string
}

export interface RunAdmissionPort {
  confirmCapabilities(input: {
    readonly connection: ConnectionRecord
    readonly capabilities: PublicCapabilitySnapshot
    readonly capabilityDigest: string
    readonly signal?: AbortSignal
  }): Promise<void>
  admit(input: {
    readonly profile: Readonly<AgentProfile>
    readonly connection: ConnectionRecord
    readonly operationId: string
    readonly requestDigest: string
    readonly effectiveProfileDigest: string
    readonly capabilityDigest: string
    readonly capabilities: PublicCapabilitySnapshot
    readonly workspace?: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }): Promise<ProviderMaterializationReceipt>
}

export interface PublicCapabilitySnapshot {
  readonly environment: AgentEnvironmentCapabilities
  readonly supportedRunners: readonly string[]
  readonly modelIds: readonly string[]
  readonly modelReasoning: Readonly<Record<string, unknown>>
  readonly retrievedAt: string
  readonly source: string
  readonly digest: string
}

export type AdmissionConnectionSummary = Pick<
  ConnectionRecord,
  'id' | 'kind' | 'name' | 'endpoint' | 'account'
>

export interface AdmissionValidation {
  readonly issues: readonly AgentProfileValidationIssue[]
  readonly acceptedWarningCodes: readonly string[]
  readonly normalizedProfile?: Readonly<AgentProfile>
  readonly normalizedProfileDigest?: string
  /** True when the caller explicitly accepted the provider's normalized profile. */
  readonly normalizedProfileAccepted: boolean
}

export interface PreAdmissionReceipt {
  readonly kind: 'braid.pre-admission'
  readonly schemaVersion: 1
  readonly receiptDigest: string
  readonly requestedAt: string
  readonly identifiers: RunIdentifiers
  readonly source: ProfileDocument['source']
  readonly sourceRevision?: string
  readonly authoredProfile: Readonly<AgentProfile>
  readonly authoredProfileDigest: string
  /** The profile that will be dispatched, after any accepted normalization. */
  readonly effectiveProfile: Readonly<AgentProfile>
  readonly effectiveProfileDigest: string
  readonly requested: RunOverrides
  readonly selection: EffectiveRunSelection
  /** Immutable identity of the connection this admission is bound to. */
  readonly connection: AdmissionConnectionSummary
  readonly connectionIdentityDigest: string
  readonly capabilities: PublicCapabilitySnapshot
  readonly schema: ProfileSchemaIdentity
  readonly validation: AdmissionValidation
  readonly workspace: AdmissionWorkspace
}

export interface PostMaterializationReceipt {
  readonly kind: 'braid.post-materialization'
  readonly schemaVersion: 1
  readonly receiptDigest: string
  readonly preAdmissionDigest: string
  readonly admittedAt: string
  readonly identifiers: RunIdentifiers
  readonly authoredProfileDigest: string
  readonly effectiveProfileDigest: string
  readonly connection: AdmissionConnectionSummary
  readonly connectionIdentityDigest: string
  readonly capabilities: PublicCapabilitySnapshot
  readonly schema: ProfileSchemaIdentity
  readonly requested: RunOverrides
  readonly selection: EffectiveRunSelection
  readonly validation: AdmissionValidation
  readonly materialization: ProviderMaterializationReceipt
  readonly workspace: AdmissionWorkspace
}

export interface AdmissionResult {
  readonly preAdmission: PreAdmissionReceipt
  readonly postMaterialization?: PostMaterializationReceipt
}

/**
 * A prepared admission. The connection is captured here, not accepted again at
 * dispatch, so the receipt and the runtime cannot name different connections.
 */
export interface PreparedAdmission {
  readonly selection: EffectiveRunSelection
  readonly preAdmission: PreAdmissionReceipt
  readonly connection: ConnectionRecord
  readonly capabilities: ConnectionCapabilitySnapshot
  readonly workspaceAuthority?: Readonly<{
    readonly identity: WorkspaceIdentity
    readonly files: readonly WorkspaceInspectionFile[]
  }>
  readonly workspaceTrust?: WorkspaceTrustRecord
}

export interface ReceiptStore {
  savePreAdmission(receipt: PreAdmissionReceipt): Promise<void>
  savePostMaterialization(receipt: PostMaterializationReceipt): Promise<void>
  findPostMaterialization?(
    preAdmissionDigest: string,
  ): Promise<PostMaterializationReceipt | undefined>
}

export class MaterializationReceiptConflictError extends Error {
  constructor(key: string) {
    super(`A different materialization receipt already exists for ${key}`)
    this.name = 'MaterializationReceiptConflictError'
  }
}

export class MemoryReceiptStore implements ReceiptStore {
  readonly #pre = new Map<string, PreAdmissionReceipt>()
  readonly #post = new Map<string, PostMaterializationReceipt>()

  async savePreAdmission(receipt: PreAdmissionReceipt): Promise<void> {
    const normalized = normalizeStoredPreAdmission(receipt)
    const existing = this.#pre.get(normalized.receiptDigest)
    if (existing !== undefined && canonicalDigest(existing) !== canonicalDigest(normalized)) {
      throw new MaterializationReceiptConflictError(receipt.receiptDigest)
    }
    this.#pre.set(normalized.receiptDigest, normalized)
  }

  async savePostMaterialization(receipt: PostMaterializationReceipt): Promise<void> {
    const normalized = normalizeStoredPostMaterialization(receipt)
    const pre = this.#pre.get(normalized.preAdmissionDigest)
    if (pre === undefined) {
      throw new Error('Post-materialization receipt requires its pre-admission receipt')
    }
    assertPostMatchesPre(pre, normalized)
    const existing = this.#post.get(normalized.preAdmissionDigest)
    if (existing !== undefined && canonicalDigest(existing) !== canonicalDigest(normalized)) {
      throw new MaterializationReceiptConflictError(normalized.preAdmissionDigest)
    }
    this.#post.set(normalized.preAdmissionDigest, normalized)
  }

  async findPostMaterialization(
    preAdmissionDigest: string,
  ): Promise<PostMaterializationReceipt | undefined> {
    return this.#post.get(preAdmissionDigest)
  }

  preAdmissions(): readonly PreAdmissionReceipt[] {
    return Object.freeze([...this.#pre.values()])
  }

  postMaterializations(): readonly PostMaterializationReceipt[] {
    return Object.freeze([...this.#post.values()])
  }
}

export function freezeCapabilitySnapshot(
  capabilities: ConnectionCapabilitySnapshot,
): PublicCapabilitySnapshot {
  const snapshot = {
    environment: freezeJson(structuredClone(capabilities.environment)),
    supportedRunners: Object.freeze(
      capabilities.supportedRunners.map((value) => redactProviderText(value, 512) ?? '[redacted]'),
    ),
    modelIds: Object.freeze(
      capabilities.modelIds.map((value) => redactProviderText(value, 512) ?? '[redacted]'),
    ),
    modelReasoning: freezeJson(structuredClone(capabilities.modelReasoning)),
    retrievedAt: redactProviderText(capabilities.retrievedAt, 128) ?? '<unknown time>',
    source: redactProviderText(capabilities.source, 256) ?? 'provider',
  }
  return Object.freeze({
    ...snapshot,
    digest: publicCapabilitySnapshotDigest(snapshot),
  })
}

export function connectionSummary(connection: ConnectionRecord): AdmissionConnectionSummary {
  return Object.freeze({
    id: connection.id,
    kind: connection.kind,
    name: redactProviderText(connection.name, 256) ?? 'connection',
    ...(connection.endpoint === undefined
      ? {}
      : { endpoint: redactProviderText(connection.endpoint, 2_048) ?? '<redacted endpoint>' }),
    ...(connection.account === undefined
      ? {}
      : { account: redactProviderText(connection.account, 256) ?? '<redacted account>' }),
  })
}

export function freezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child)
  return Object.freeze(value)
}
