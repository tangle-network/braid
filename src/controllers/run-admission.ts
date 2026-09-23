import { resolve } from 'node:path'
import type { AgentProfile, AgentProfileSecurityPolicy } from '@tangle-network/agent-interface'
import {
  type ConnectionCapabilitySnapshot,
  type ConnectionProviderPort,
  type ConnectionRecord,
  withCapabilityDigest,
  validateConnectionRecord,
} from '../connection/connections.js'
import { redactErrorMessage } from '../connection/redaction.js'
import {
  type VerifiedWorkspaceTrust,
  type WorkspaceTrustPreview,
  type WorkspaceInspectionFile,
  type WorkspaceIdentity,
  WorkspaceNotTrustedError,
  type WorkspaceTrustStore,
  inspectWorkspaceTrust,
  verifyWorkspaceTrust,
} from '../connection/workspace-trust.js'
import { canonicalDigest } from '../domain/canonical.js'
import { profileSchemaIdentity } from '../profile/profile-schema-identity.js'
import type { ProfileDocument } from '../profile/profile-sources.js'
import { validateCanonicalProfile } from '../profile/profile-validation.js'
import {
  type RunOverrides,
  resolveEffectiveRun,
  type SelectionLayers,
  selectionDimensions,
  selectionHasBlockingUnsupportedValue,
} from '../profile/run-selection.js'
import {
  type AdmissionResult,
  freezeCapabilitySnapshot,
  type PreparedAdmission,
  type ReceiptStore,
  type RunAdmissionPort,
  type RunIdentifiers,
} from './admission-contracts.js'
import {
  normalizeRunIdentifiers,
  normalizeRunOverrides,
  normalizeSecurityPolicy,
  normalizeSelectionLayers,
  normalizeWarningCodes,
  normalizeWorkspaceRequest,
} from './admission-input.js'
import {
  type AdmissionLedger,
  admissionOperationDigest,
  completeAdmission,
  failAdmission,
  MemoryAdmissionLedger,
  requireOperationId,
  reserveAdmission,
} from './admission-ledger.js'
import { validateMaterializationReceipt } from './materialization-receipt.js'
import {
  assertProfileDocumentBinding,
  connectionIdentityDigest,
  requiredWorkspaceCapabilities,
  safeProfileSource,
  validateAdmissionProfile,
  workspaceRecord,
} from './admission-support.js'
import { AdmissionRecoveryError, recoverMaterializedAdmission } from './admission-recovery.js'
export { AdmissionRecoveryError } from './admission-recovery.js'
import {
  createPostMaterializationReceipt,
  createPreAdmissionReceipt,
} from './admission-receipts.js'
import { normalizeStoredPreAdmission } from './receipt-store-validation.js'

export type {
  AdmissionResult,
  AdmissionWorkspace,
  PostMaterializationReceipt,
  PreAdmissionReceipt,
  PreparedAdmission,
  ProviderMaterializationPath,
  ProviderMaterializationReceipt,
  PublicCapabilitySnapshot,
  ReceiptStore,
  RunAdmissionPort,
  RunIdentifiers,
} from './admission-contracts.js'
export { MemoryReceiptStore } from './admission-contracts.js'

export class AdmissionBindingError extends Error {
  constructor(detail: string) {
    super(`Admission is not bound to what was prepared: ${detail}`)
    this.name = 'AdmissionBindingError'
  }
}

export interface RunAdmissionOptions {
  readonly provider: ConnectionProviderPort
  readonly runtime: RunAdmissionPort
  readonly receipts: ReceiptStore
  readonly workspaceTrust?: WorkspaceTrustStore
  readonly ledger?: AdmissionLedger
  readonly now: () => string
}

export interface PrepareAdmissionInput {
  readonly identifiers: RunIdentifiers
  readonly source: ProfileDocument
  readonly connection: ConnectionRecord
  readonly layers?: SelectionLayers
  readonly overrides?: RunOverrides
  readonly workspace?: {
    readonly identity?: string
    readonly trustPreview?: WorkspaceTrustPreview
    readonly request?: Readonly<Record<string, unknown>>
    readonly authority?: {
      readonly identity: WorkspaceIdentity
      readonly files: readonly WorkspaceInspectionFile[]
    }
  }
  readonly securityPolicy?: AgentProfileSecurityPolicy
  readonly acceptedWarningCodes?: readonly string[]
  /** Dispatch the provider's normalized profile instead of Braid's selection. */
  readonly acceptNormalizedProfile?: boolean
  readonly signal?: AbortSignal
}

function sameWorkspaceRoot(left: string, right: string): boolean {
  try {
    return resolve(left) === resolve(right)
  } catch {
    return false
  }
}

function assertWorkspaceAuthorityBinding(workspace: PrepareAdmissionInput['workspace']): void {
  if (
    workspace?.authority !== undefined &&
    workspace.identity !== undefined &&
    !sameWorkspaceRoot(workspace.identity, workspace.authority.identity.root)
  ) {
    throw new AdmissionBindingError('workspace identity differs from its inspected authority')
  }
}

export class RunAdmissionController {
  readonly #provider: ConnectionProviderPort
  readonly #runtime: RunAdmissionPort
  readonly #receipts: ReceiptStore
  readonly #trust: WorkspaceTrustStore | undefined
  readonly #ledger: AdmissionLedger
  readonly #now: () => string

  constructor(options: RunAdmissionOptions) {
    this.#provider = options.provider
    this.#runtime = options.runtime
    this.#receipts = options.receipts
    this.#trust = options.workspaceTrust
    this.#ledger = options.ledger ?? new MemoryAdmissionLedger()
    this.#now = options.now
  }

  async prepare(input: PrepareAdmissionInput): Promise<PreparedAdmission> {
    const identifiers = normalizeRunIdentifiers(input.identifiers)
    requireOperationId(identifiers.operationId)
    if (input.source.saveBlock !== undefined) {
      throw new Error(
        `Admission refuses a profile that cannot be safely saved: ${input.source.saveBlock}`,
      )
    }
    const connection = validateConnectionRecord(input.connection)
    const securityPolicy = normalizeSecurityPolicy(
      input.securityPolicy ?? input.source.securityPolicy,
    )
    assertWorkspaceAuthorityBinding(input.workspace)
    const layers = normalizeSelectionLayers(input.layers)
    const overrides = normalizeRunOverrides(input.overrides)
    const acceptedWarningCodes = normalizeWarningCodes(input.acceptedWarningCodes)
    if (
      input.acceptNormalizedProfile !== undefined &&
      typeof input.acceptNormalizedProfile !== 'boolean'
    ) {
      throw new Error('acceptNormalizedProfile must be a boolean')
    }
    const workspaceRequest = normalizeWorkspaceRequest(input.workspace?.request)
    const canonical = validateCanonicalProfile(
      input.source.fullValue,
      securityPolicy === undefined ? {} : { securityPolicy },
    )
    if (!canonical.ok || canonical.profile === undefined || canonical.digest === undefined) {
      throw new Error(
        canonical.issues
          .map((issue) => redactErrorMessage(`${issue.code}: ${issue.message}`))
          .join('; '),
      )
    }
    assertProfileDocumentBinding(canonical.digest, input.source.profileDigest)
    let capabilities: ConnectionCapabilitySnapshot
    try {
      capabilities = withCapabilityDigest(
        await this.#provider.capabilities(
          connection,
          input.signal === undefined ? {} : { signal: input.signal },
        ),
      )
    } catch (error) {
      throw new Error(redactErrorMessage(error))
    }
    const effectiveLayers: SelectionLayers = {
      ...layers,
      ...(overrides === undefined ? {} : { nextRun: overrides }),
    }
    const selection = resolveEffectiveRun(canonical.profile, effectiveLayers, {
      supportedRunners: capabilities.supportedRunners,
      modelIds: capabilities.modelIds,
      modelReasoning: capabilities.modelReasoning,
      profileCapabilities: capabilities.environment.profile,
    })
    if (selectionHasBlockingUnsupportedValue(selection)) {
      throw new Error(
        selectionDimensions(selection)
          .filter((value) => value.fidelity === 'unsupported')
          .map((value) => value.reason ?? 'unsupported run selection')
          .join('; '),
      )
    }

    const validation = await validateAdmissionProfile({
      provider: this.#provider,
      connection,
      selection,
      capabilities,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(securityPolicy === undefined ? {} : { securityPolicy }),
      ...(acceptedWarningCodes === undefined ? {} : { acceptedWarningCodes }),
      ...(input.acceptNormalizedProfile === undefined
        ? {}
        : { acceptNormalizedProfile: input.acceptNormalizedProfile }),
      sourceKind: input.source.source.kind,
    })
    const effectiveProfile = validation.normalizedProfileAccepted
      ? (validation.normalizedProfile ?? selection.profile)
      : selection.profile

    const trust = await this.#requireTrust(
      effectiveProfile,
      securityPolicy,
      input.workspace,
      workspaceRequest,
      input.source.source.kind,
    )
    const publicCapabilities = freezeCapabilitySnapshot(capabilities)
    const workspace = workspaceRecord(
      input.workspace?.authority?.identity.root ?? input.workspace?.identity,
      trust,
      workspaceRequest,
    )
    const identityDigest = connectionIdentityDigest(connection)
    const receiptSource = safeProfileSource(input.source.source)
    const preAdmission = createPreAdmissionReceipt({
      requestedAt: this.#now(),
      identifiers,
      source: receiptSource,
      authoredProfile: canonical.profile,
      authoredProfileDigest: canonical.digest,
      effectiveProfile,
      requested: Object.freeze({ ...(overrides ?? {}) }),
      selection,
      connection,
      connectionIdentityDigest: identityDigest,
      capabilities: publicCapabilities,
      schema: Object.freeze({ ...profileSchemaIdentity() }),
      validation,
      workspace,
    })
    await this.#receipts.savePreAdmission(preAdmission)
    return Object.freeze({
      selection,
      preAdmission,
      connection,
      capabilities,
      ...(input.workspace?.authority === undefined
        ? {}
        : { workspaceAuthority: input.workspace.authority }),
      ...(trust === undefined ? {} : { workspaceTrust: trust.record }),
    })
  }

  async #requireTrust(
    profile: Readonly<AgentProfile>,
    securityPolicy: AgentProfileSecurityPolicy | undefined,
    workspace: PrepareAdmissionInput['workspace'],
    request: Readonly<Record<string, unknown>> | undefined,
    sourceKind: ProfileDocument['source']['kind'],
  ): Promise<VerifiedWorkspaceTrust | undefined> {
    const required = requiredWorkspaceCapabilities(profile, securityPolicy, request, sourceKind)
    if (required.length === 0) return undefined
    if (workspace?.authority === undefined || this.#trust === undefined) {
      throw new WorkspaceNotTrustedError(
        {
          root: workspace?.authority?.identity.root ?? workspace?.identity ?? '<unknown workspace>',
        },
        'authoritative workspace files and an approval record are required',
      )
    }
    const preview = await inspectWorkspaceTrust(
      workspace.authority.identity,
      workspace.authority.files,
    )
    return verifyWorkspaceTrust(this.#trust, preview, required)
  }

  /**
   * Dispatch a prepared admission. The connection comes from the prepared value;
   * a caller-supplied connection is only accepted as an assertion that must match
   * the prepared identity exactly.
   */
  async admit(input: {
    readonly prepared: PreparedAdmission
    readonly connection?: ConnectionRecord
    readonly signal?: AbortSignal
  }): Promise<AdmissionResult> {
    let preAdmission: PreparedAdmission['preAdmission']
    let selection: PreparedAdmission['selection']
    let connection: ConnectionRecord
    let preparedCapabilities: ConnectionCapabilitySnapshot
    try {
      preAdmission = normalizeStoredPreAdmission(input.prepared.preAdmission)
      const suppliedSelection = input.prepared.selection
      if (canonicalDigest(suppliedSelection) !== canonicalDigest(preAdmission.selection)) {
        throw new AdmissionBindingError('the prepared selection differs from its receipt')
      }
      selection = preAdmission.selection
      connection = validateConnectionRecord(input.prepared.connection)
      preparedCapabilities = withCapabilityDigest(input.prepared.capabilities)
      if (
        freezeCapabilitySnapshot(preparedCapabilities).digest !== preAdmission.capabilities.digest
      ) {
        throw new AdmissionBindingError('the prepared capabilities differ from its receipt')
      }
      if (
        input.prepared.workspaceAuthority !== undefined &&
        (preAdmission.workspace.identity === undefined ||
          !sameWorkspaceRoot(
            preAdmission.workspace.identity,
            input.prepared.workspaceAuthority.identity.root,
          ))
      ) {
        throw new AdmissionBindingError('prepared workspace differs from its trust receipt')
      }
    } catch (error) {
      if (error instanceof AdmissionBindingError) throw error
      throw new AdmissionBindingError(`prepared state is invalid: ${redactErrorMessage(error)}`)
    }
    if (input.connection !== undefined) {
      const assertedConnection = validateConnectionRecord(input.connection)
      const asserted = connectionIdentityDigest(assertedConnection)
      if (asserted !== preAdmission.connectionIdentityDigest) {
        throw new AdmissionBindingError(
          `connection ${assertedConnection.id} differs from the prepared connection ${connection.id}`,
        )
      }
    }
    if (connectionIdentityDigest(connection) !== preAdmission.connectionIdentityDigest) {
      throw new AdmissionBindingError('the prepared connection changed after preparation')
    }

    let confirmedCapabilities: ConnectionCapabilitySnapshot
    try {
      confirmedCapabilities = withCapabilityDigest(
        await this.#provider.capabilities(
          connection,
          input.signal === undefined ? {} : { signal: input.signal },
        ),
      )
    } catch (error) {
      throw new AdmissionBindingError(
        `provider capability confirmation failed: ${redactErrorMessage(error)}`,
      )
    }
    if (
      confirmedCapabilities.digest !== preparedCapabilities.digest ||
      preAdmission.capabilities.digest !== freezeCapabilitySnapshot(confirmedCapabilities).digest
    ) {
      throw new AdmissionBindingError('provider capabilities changed after preparation')
    }
    if (
      input.prepared.workspaceAuthority !== undefined &&
      preAdmission.workspace.trust !== undefined
    ) {
      if (this.#trust === undefined) {
        throw new AdmissionBindingError('workspace approval authority is missing')
      }
      const preview = await inspectWorkspaceTrust(
        input.prepared.workspaceAuthority.identity,
        input.prepared.workspaceAuthority.files,
      )
      const verified = verifyWorkspaceTrust(
        this.#trust,
        preview,
        preAdmission.workspace.trust.capabilities,
      )
      if (
        verified === undefined ||
        verified.record.configurationDigest !== preAdmission.workspace.trust.configurationDigest
      ) {
        throw new AdmissionBindingError('workspace files changed after approval')
      }
    }
    try {
      await this.#runtime.confirmCapabilities({
        connection,
        capabilities: preAdmission.capabilities,
        capabilityDigest: preAdmission.capabilities.digest,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (error) {
      throw new AdmissionBindingError(
        `runtime capability confirmation failed: ${redactErrorMessage(error)}`,
      )
    }

    const operationDigest = admissionOperationDigest({
      identifiers: { ...preAdmission.identifiers },
      authoredProfileDigest: preAdmission.authoredProfileDigest,
      effectiveProfileDigest: preAdmission.effectiveProfileDigest,
      connectionIdentityDigest: preAdmission.connectionIdentityDigest,
      selectionDigest: canonicalDigest(selection),
      workspaceDigest: canonicalDigest(preAdmission.workspace),
      capabilityDigest: preAdmission.capabilities.digest,
    })
    const recovered = await recoverMaterializedAdmission({
      ledger: this.#ledger,
      receipts: this.#receipts,
      preAdmission,
      operationDigest,
      now: this.#now,
    })
    if (recovered !== undefined) return recovered
    const startedAt = this.#now()
    const reservation = await reserveAdmission(this.#ledger, {
      operationId: preAdmission.identifiers.operationId,
      operationDigest,
      now: startedAt,
    })
    if (reservation.replayReceiptDigest !== undefined) {
      if (this.#receipts.findPostMaterialization === undefined) {
        throw new AdmissionRecoveryError('the materialization receipt store cannot replay outcomes')
      }
      const postMaterialization = await this.#receipts.findPostMaterialization(
        preAdmission.receiptDigest,
      )
      if (
        postMaterialization === undefined ||
        postMaterialization.receiptDigest !== reservation.replayReceiptDigest ||
        postMaterialization.preAdmissionDigest !== preAdmission.receiptDigest
      ) {
        throw new AdmissionRecoveryError(
          'the ledger has a materialized operation but its matching receipt is unavailable',
        )
      }
      return Object.freeze({
        preAdmission,
        postMaterialization,
      })
    }

    let dispatched = false
    try {
      dispatched = true
      const materialization = await this.#runtime.admit({
        profile: preAdmission.effectiveProfile,
        connection,
        operationId: preAdmission.identifiers.operationId,
        requestDigest: preAdmission.receiptDigest,
        effectiveProfileDigest: preAdmission.effectiveProfileDigest,
        capabilityDigest: preAdmission.capabilities.digest,
        capabilities: preAdmission.capabilities,
        ...(preAdmission.workspace.request === undefined
          ? {}
          : { workspace: preAdmission.workspace.request }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      const validated = validateMaterializationReceipt(materialization, {
        requestDigest: preAdmission.receiptDigest,
        effectiveProfileDigest: preAdmission.effectiveProfileDigest,
        capabilityDigest: preAdmission.capabilities.digest,
        expectedUnsupportedDimensions: preAdmission.validation.issues
          .filter((issue) => issue.code === 'UNSUPPORTED_PROFILE_DIMENSION')
          .flatMap((issue) => (issue.path === undefined ? [] : [issue.path])),
      })
      const admittedAt = this.#now()
      const postMaterialization = createPostMaterializationReceipt({
        admittedAt,
        preAdmission,
        selection,
        materialization: validated,
      })
      await this.#receipts.savePostMaterialization(postMaterialization)
      await completeAdmission(this.#ledger, {
        operationId: preAdmission.identifiers.operationId,
        operationDigest,
        startedAt,
        completedAt: admittedAt,
        receiptDigest: postMaterialization.receiptDigest,
      })
      return Object.freeze({ preAdmission, postMaterialization })
    } catch (error) {
      if (dispatched) {
        const recovered = await recoverMaterializedAdmission({
          ledger: this.#ledger,
          receipts: this.#receipts,
          preAdmission,
          operationDigest,
          now: this.#now,
        })
        if (recovered !== undefined) return recovered
        throw new AdmissionRecoveryError(
          `provider admission completed or may have completed, but its durable outcome is unavailable: ${redactErrorMessage(error)}`,
        )
      }
      try {
        await failAdmission(this.#ledger, {
          operationId: preAdmission.identifiers.operationId,
          operationDigest,
          startedAt,
          completedAt: this.#now(),
          failure: redactErrorMessage(error),
        })
      } catch (ledgerError) {
        throw new Error(
          `${redactErrorMessage(error)}; admission outcome could not be recorded: ${redactErrorMessage(ledgerError)}`,
        )
      }
      throw new Error(redactErrorMessage(error))
    }
  }
}
