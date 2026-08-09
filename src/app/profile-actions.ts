import type { AgentProfileSecurityPolicy } from '@tangle-network/agent-interface'
import { parseProfileId } from '../domain/ids.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { ActionHost } from './action-host.js'
import { operationReplay, parseOperation, requestDigest } from './conversation-support.js'
import { AppError } from './errors.js'
import {
  acknowledgedProfileOperation,
  findProfileRecord,
  fromDomainProfile,
  invalidProfile,
  newProfileFileTarget,
  pendingProfileOperation,
  profileRevision,
  profileSaveFromOperation,
  profileSaveIntentFromOperation,
  profileSelectionFromOperation,
  profileSelectionOperationResult,
  reconciliationRequired,
  type SafeProfileValidationReport,
  safeProfileSummary,
  safeValidationReport,
  toDomainProfile,
} from './profile-action-support.js'
import {
  acknowledgeProfileSave,
  createProfileSaveIntent,
  handleProfileSaveFailure,
  type ProfileSaveRecoveryRuntime,
  recoverPendingProfileSave,
} from './profile-save-recovery.js'
import {
  createProfileRecord,
  discoverProfiles,
  type ProfileDiscoveryInput,
  type ProfileDiscoveryIssue,
  type ProfileProvider,
  type ProfileSummary,
  type ProfileValidationOptions,
  profileSourceKey,
  type ProfileRecord as SourceProfileRecord,
  resolveEffectiveProfile,
  saveProfileFile,
  searchProfiles,
  selectBaseProfile,
  validateProfile,
} from './profiles.js'

export interface ProfileActionOptions {
  readonly host: ActionHost
  readonly profiles?: readonly SourceProfileRecord[]
  readonly discovery?: ProfileDiscoveryInput
  readonly provider?: ProfileProvider
  readonly securityPolicy?: AgentProfileSecurityPolicy
  readonly acceptedProviderWarningCodes?: readonly string[]
  readonly now?: () => string
  readonly onSavePhase?: (
    phase:
      | 'pending-committed'
      | 'temporary-written'
      | 'temporary-fsynced'
      | 'renamed'
      | 'directory-fsynced'
      | 'acknowledgment',
  ) => void
}

export type { SafeProfileValidationReport } from './profile-action-support.js'

export interface ProfileListResult {
  readonly profiles: readonly ProfileSummary[]
  readonly issues: readonly ProfileDiscoveryIssue[]
}

export interface ProfileValidationResult {
  readonly ref: string
  readonly report: SafeProfileValidationReport
  readonly effective: {
    readonly authoredProfile: { readonly name?: string }
    readonly runner?: string
    readonly model?: string
    readonly compatibility: ReturnType<typeof resolveEffectiveProfile>['compatibility']
  }
}

export interface ProfileSelectionResult {
  readonly profile: ProfileSummary
  readonly reason: 'command-line' | 'branch' | 'workspace' | 'user' | 'first-run'
  readonly revision: number
  readonly replayed: boolean
}

export interface ProfileSaveResult {
  readonly profile: ProfileSummary
  readonly path: string
  readonly bytesDigest: string
  readonly revision: number
  readonly replayed: boolean
}

interface CatalogResult {
  readonly records: readonly SourceProfileRecord[]
  readonly issues: readonly ProfileDiscoveryIssue[]
}

export class ProfileActionService {
  readonly #options: ProfileActionOptions

  constructor(options: ProfileActionOptions) {
    this.#options = options
  }

  async list(query = ''): Promise<ProfileListResult> {
    const catalog = await this.#catalog()
    return {
      profiles: searchProfiles(catalog.records, query).map((record) => this.#summary(record)),
      issues: catalog.issues,
    }
  }

  async validate(ref: string): Promise<ProfileValidationResult> {
    const catalog = await this.#catalog()
    const record = this.#requireRecord(catalog.records, ref)
    const report = await validateProfile(record.profile, this.#validationOptions())
    const availableModelIds = [
      ...new Set(
        catalog.records.flatMap((candidate) =>
          [candidate.profile.model?.default, candidate.profile.model?.small].filter(
            (model): model is string => model !== undefined,
          ),
        ),
      ),
    ]
    const effective = resolveEffectiveProfile({ profile: record, availableModelIds })
    return {
      ref: redactSensitiveText(ref, 2048),
      report: safeValidationReport(report),
      effective: {
        authoredProfile: {
          ...(record.profile.name === undefined
            ? {}
            : { name: redactSensitiveText(record.profile.name, 512) }),
        },
        ...(effective.runner === undefined ? {} : { runner: effective.runner }),
        ...(effective.model === undefined ? {} : { model: effective.model }),
        compatibility: effective.compatibility,
      },
    }
  }

  async select(input: {
    readonly operationId: string
    readonly ref: string
    readonly expectedRevision?: number
  }): Promise<ProfileSelectionResult> {
    const operationId = parseOperation(input.operationId, 'select_profile')
    const digest = requestDigest('select_profile', {
      ref: input.ref,
      expectedRevision: input.expectedRevision ?? null,
    })
    const replay = operationReplay(this.#options.host.state(), operationId, 'profile-save', digest)
    if (replay !== undefined) {
      if (replay.status !== 'acknowledged') throw reconciliationRequired(operationId)
      const result = profileSelectionFromOperation(replay)
      if (result === undefined) throw reconciliationRequired(operationId)
      this.#options.host.runtime?.syncFromState(this.#options.host.state())
      return {
        profile: result.profile,
        reason: result.reason,
        revision: this.#options.host.state().revision,
        replayed: true,
      }
    }

    const record = await this.#find(input.ref)
    const validation = await validateProfile(record.profile, this.#validationOptions())
    if (!validation.ok) throw invalidProfile(validation)
    const selection = selectBaseProfile({ commandLine: record })
    if (selection === undefined) throw new AppError('PROFILE_NOT_FOUND', 'Profile not found')
    const next = await this.#options.host.configuration.selectProfile({
      profile: toDomainProfile(record, this.#now()),
      operation: acknowledgedProfileOperation({
        id: operationId,
        digest,
        at: this.#now(),
        result: {
          profileId: record.id,
          ...profileSelectionOperationResult(this.#summary(record), selection.reason),
        },
      }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    })
    this.#options.host.runtime?.setProfile(record.profile)
    return {
      profile: this.#summary(record),
      reason: selection.reason,
      revision: next.revision,
      replayed: false,
    }
  }

  async save(input: {
    readonly operationId: string
    readonly ref: string
    readonly profile: unknown
    readonly expectedRevision?: number
  }): Promise<ProfileSaveResult> {
    const operationId = parseOperation(input.operationId, 'save_profile')
    const digest = requestDigest('save_profile', {
      ref: input.ref,
      profile: input.profile,
      expectedRevision: input.expectedRevision ?? null,
    })
    const replay = operationReplay(this.#options.host.state(), operationId, 'profile-save', digest)
    if (replay !== undefined) {
      if (replay.status === 'pending') {
        const intent = profileSaveIntentFromOperation(replay)
        if (intent === undefined) throw reconciliationRequired(operationId)
        return recoverPendingProfileSave(
          this.#recoveryRuntime(),
          input,
          operationId,
          digest,
          intent,
        )
      }
      if (replay.status !== 'acknowledged') throw reconciliationRequired(operationId)
      const saved = profileSaveFromOperation(replay)
      if (saved === undefined) throw reconciliationRequired(operationId)
      this.#options.host.runtime?.syncFromState(this.#options.host.state())
      return {
        profile: saved.profile,
        path: saved.path,
        bytesDigest: saved.bytesDigest,
        revision: this.#options.host.state().revision,
        replayed: true,
      }
    }

    const report = await validateProfile(input.profile, this.#validationOptions())
    if (!report.ok || report.profile === undefined || report.digest === undefined)
      throw invalidProfile(report)
    const catalog = await this.#catalog()
    const existing = findProfileRecord(catalog.records, input.ref)
    const target = existing === undefined ? { source: newProfileFileTarget(input.ref) } : existing
    if (target.source.kind !== 'file' || !target.source.writable) {
      throw new AppError('PROFILE_READ_ONLY', 'The selected profile source is not writable')
    }

    const expectedBytesDigest = profileRevision(target.source.revision)
    const expectedProfileDigest = profileRevision(existing?.digest)
    const draftRecord =
      existing === undefined
        ? createProfileRecord(target.source, report.profile)
        : {
            ...existing,
            profile: report.profile,
            digest: report.digest,
            displayName: report.profile.name ?? existing.displayName,
          }
    const selected = this.#options.host.state().selectedProfileId === parseProfileId(draftRecord.id)
    const intent = createProfileSaveIntent({
      path: target.source.reference,
      profile: report.profile,
      summary: this.#summary(draftRecord),
      ...(expectedBytesDigest === undefined ? {} : { expectedBytesDigest }),
      ...(expectedProfileDigest === undefined ? {} : { expectedProfileDigest }),
      expectedMissing: existing === undefined,
      sourceLabel: target.source.label,
      trusted: target.source.trusted,
      profileId: draftRecord.id,
      select: selected,
    })
    const pending = pendingProfileOperation(operationId, digest, this.#now(), intent)
    await this.#options.host.configuration.requestOperation({
      operation: pending,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    })
    try {
      this.#options.onSavePhase?.('pending-committed')
      const saved = saveProfileFile(target.source.reference, report.profile, {
        overwrite: true,
        ...(expectedBytesDigest === undefined ? {} : { expectedBytesDigest }),
        ...(expectedProfileDigest === undefined ? {} : { expectedProfileDigest }),
        ...(existing === undefined ? { expectedBytesAbsent: true } : {}),
        sourceLabel: target.source.label,
        trusted: target.source.trusted,
        onPhase: (phase) => this.#options.onSavePhase?.(phase),
      })
      const savedRecord =
        existing === undefined ? saved.record : { ...saved.record, id: existing.id }
      this.#options.onSavePhase?.('acknowledgment')
      return acknowledgeProfileSave(
        this.#recoveryRuntime(),
        operationId,
        digest,
        intent,
        savedRecord,
        saved.path,
        saved.bytesDigest,
        false,
      )
    } catch (error) {
      await handleProfileSaveFailure(this.#recoveryRuntime(), operationId, digest, intent)
      throw error
    }
  }

  async saveCurrent(input: {
    readonly operationId: string
    readonly ref: string
    readonly expectedRevision?: number
  }): Promise<ProfileSaveResult> {
    const profile = this.#options.host.runtime?.profile() ?? this.#options.host.state().profile
    return this.save({ ...input, profile })
  }

  async #catalog(): Promise<CatalogResult> {
    const records = new Map<string, SourceProfileRecord>()
    for (const record of this.#options.host.state().profiles.map(fromDomainProfile)) {
      records.set(profileSourceKey(record), record)
    }
    for (const record of this.#options.profiles ?? []) records.set(profileSourceKey(record), record)
    const discovered =
      this.#options.discovery === undefined
        ? { profiles: [], issues: [] }
        : await discoverProfiles(this.#options.discovery)
    for (const record of discovered.profiles) records.set(profileSourceKey(record), record)
    if (records.size === 0) {
      const active = createProfileRecord(
        {
          kind: 'inline',
          reference: 'braid:active',
          label: this.#options.host.state().profile.name ?? 'Active profile',
          writable: false,
          trusted: true,
        },
        this.#options.host.state().profile,
      )
      records.set(profileSourceKey(active), active)
    }
    return { records: [...records.values()], issues: discovered.issues }
  }

  async #find(ref: string): Promise<SourceProfileRecord> {
    const catalog = await this.#catalog()
    return this.#requireRecord(catalog.records, ref)
  }

  #requireRecord(records: readonly SourceProfileRecord[], ref: string): SourceProfileRecord {
    const record = findProfileRecord(records, ref)
    if (record === undefined) {
      throw new AppError(
        'PROFILE_NOT_FOUND',
        `Profile ${redactSensitiveText(ref, 2048)} was not found`,
      )
    }
    return record
  }

  #summary(record: SourceProfileRecord): ProfileSummary {
    return safeProfileSummary(record)
  }

  #validationOptions(): ProfileValidationOptions {
    return {
      ...(this.#options.securityPolicy === undefined
        ? {}
        : { securityPolicy: this.#options.securityPolicy }),
      ...(this.#options.provider === undefined ? {} : { provider: this.#options.provider }),
      ...(this.#options.acceptedProviderWarningCodes === undefined
        ? {}
        : { acceptedProviderWarningCodes: this.#options.acceptedProviderWarningCodes }),
    }
  }

  #now(): string {
    return this.#options.now?.() ?? new Date().toISOString()
  }

  #recoveryRuntime(): ProfileSaveRecoveryRuntime {
    return {
      host: this.#options.host,
      now: () => this.#now(),
      summary: (record) => this.#summary(record),
      ...(this.#options.onSavePhase === undefined ? {} : { onPhase: this.#options.onSavePhase }),
    }
  }
}
