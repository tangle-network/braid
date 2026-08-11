import {
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
  snapshotAgentProfile,
} from '../adapters/agent-interface/profile-runtime.js'
import { redactStructuredValue } from '../domain/bounded-structured.js'
import { exportProfileDocument } from './profile-persistence.js'
import type { ProfileIssue, ProfileSnapshotInput, ProfileSnapshotReceipt } from './profile-types.js'
import {
  AGENT_INTERFACE_PACKAGE_NAME,
  AGENT_INTERFACE_PACKAGE_VERSION,
} from './profile-validation.js'

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item, seen)
  } else {
    for (const child of Object.values(value)) freezeDeep(child, seen)
  }
  return Object.freeze(value)
}

function safeIssues(issues: readonly ProfileIssue[]): readonly ProfileIssue[] {
  return issues.map((item) => Object.freeze({ ...item }))
}

/**
 * Capture the exact source/effective profile decision before execution.
 * The stored profile values are the canonical redacted snapshots; their source
 * and effective digests remain distinct so a provider cannot hide a change.
 */
export function createProfileSnapshot(input: ProfileSnapshotInput): ProfileSnapshotReceipt {
  const authored = snapshotAgentProfile(input.effective.authoredProfile)
  const effective = snapshotAgentProfile(input.effective.effectiveProfile)
  const redactedAuthored = exportProfileDocument(authored, { redact: true }).profile
  const redactedEffective = exportProfileDocument(effective, { redact: true }).profile
  const source = Object.freeze({ ...input.source.source })
  const overrides = Object.freeze({ ...input.effective.overrides })
  const capabilities =
    input.capabilities === undefined ? undefined : structuredClone(input.capabilities)
  const base = {
    kind: 'braid-profile-snapshot' as const,
    schemaVersion: 1 as const,
    agentInterfacePackage: {
      name: AGENT_INTERFACE_PACKAGE_NAME,
      version: AGENT_INTERFACE_PACKAGE_VERSION,
    },
    source,
    authoredProfile: redactedAuthored,
    effectiveProfile: redactedEffective,
    authoredProfileDigest: canonicalAgentProfileDigest(authored),
    effectiveProfileDigest: canonicalAgentProfileDigest(effective),
    ...(input.effective.runner === undefined ? {} : { runner: input.effective.runner }),
    ...(input.effective.model === undefined ? {} : { model: input.effective.model }),
    ...(input.effective.effort === undefined ? {} : { effort: input.effective.effort }),
    ...(input.effective.mode === undefined ? {} : { mode: input.effective.mode }),
    ...(input.effective.connectionId === undefined
      ? {}
      : { connectionId: input.effective.connectionId }),
    overrides,
    validation: {
      ok: input.validation.ok,
      issues: safeIssues(input.validation.issues),
      ...(input.validation.acceptedProviderWarningCodes === undefined
        ? {}
        : {
            acceptedProviderWarningCodes: [...input.validation.acceptedProviderWarningCodes],
          }),
    },
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(input.providerMaterializationReceipt === undefined
      ? {}
      : {
          providerMaterializationReceipt: redactStructuredValue(
            input.providerMaterializationReceipt,
          ),
        }),
  }
  const receipt = {
    ...base,
    digest: canonicalCandidateDigest(base),
  } as ProfileSnapshotReceipt
  return freezeDeep(receipt)
}
