import { canonicalAgentProfileDigest, type AgentProfile } from '@tangle-network/agent-interface'
import type { ConnectionRecord } from '../connection/connections.js'
import type { ProfileDocument } from '../profile/profile-sources.js'
import type { EffectiveRunSelection, RunOverrides } from '../profile/run-selection.js'
import {
  type AdmissionValidation,
  type AdmissionWorkspace,
  connectionSummary,
  freezeJson,
  type PostMaterializationReceipt,
  type PreAdmissionReceipt,
  type ProviderMaterializationReceipt,
  type RunIdentifiers,
} from './admission-contracts.js'
import {
  postMaterializationReceiptDigest,
  preAdmissionReceiptDigest,
} from './receipt-store-validation.js'

export function createPreAdmissionReceipt(input: {
  readonly requestedAt: string
  readonly identifiers: RunIdentifiers
  readonly source: ProfileDocument['source']
  readonly authoredProfile: Readonly<AgentProfile>
  readonly authoredProfileDigest: string
  readonly effectiveProfile: Readonly<AgentProfile>
  readonly requested: RunOverrides
  readonly selection: EffectiveRunSelection
  readonly connection: ConnectionRecord
  readonly connectionIdentityDigest: string
  readonly capabilities: PreAdmissionReceipt['capabilities']
  readonly schema: PreAdmissionReceipt['schema']
  readonly validation: AdmissionValidation
  readonly workspace: AdmissionWorkspace
}): PreAdmissionReceipt {
  const withoutDigest = {
    kind: 'braid.pre-admission' as const,
    schemaVersion: 1 as const,
    requestedAt: input.requestedAt,
    identifiers: input.identifiers,
    source: input.source,
    ...(input.source.revision === undefined ? {} : { sourceRevision: input.source.revision }),
    authoredProfile: input.authoredProfile,
    authoredProfileDigest: input.authoredProfileDigest,
    effectiveProfile: input.effectiveProfile,
    effectiveProfileDigest: canonicalAgentProfileDigest(input.effectiveProfile),
    requested: input.requested,
    selection: input.selection,
    connection: connectionSummary(input.connection),
    connectionIdentityDigest: input.connectionIdentityDigest,
    capabilities: input.capabilities,
    schema: input.schema,
    validation: input.validation,
    workspace: input.workspace,
  }
  return freezeJson({
    ...withoutDigest,
    receiptDigest: preAdmissionReceiptDigest(withoutDigest),
  }) as PreAdmissionReceipt
}

export function createPostMaterializationReceipt(input: {
  readonly admittedAt: string
  readonly preAdmission: PreAdmissionReceipt
  readonly selection: EffectiveRunSelection
  readonly materialization: ProviderMaterializationReceipt
}): PostMaterializationReceipt {
  const withoutDigest = {
    kind: 'braid.post-materialization' as const,
    schemaVersion: 1 as const,
    preAdmissionDigest: input.preAdmission.receiptDigest,
    admittedAt: input.admittedAt,
    identifiers: input.preAdmission.identifiers,
    authoredProfileDigest: input.preAdmission.authoredProfileDigest,
    effectiveProfileDigest: input.preAdmission.effectiveProfileDigest,
    connection: input.preAdmission.connection,
    connectionIdentityDigest: input.preAdmission.connectionIdentityDigest,
    capabilities: input.preAdmission.capabilities,
    schema: input.preAdmission.schema,
    requested: input.preAdmission.requested,
    selection: input.selection,
    validation: input.preAdmission.validation,
    materialization: input.materialization,
    workspace: input.preAdmission.workspace,
  }
  return freezeJson({
    ...withoutDigest,
    receiptDigest: postMaterializationReceiptDigest(withoutDigest),
  }) as PostMaterializationReceipt
}
