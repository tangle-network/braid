import { basename, join, resolve } from 'node:path'
import type { AgentProfile, HarnessType } from '@tangle-network/agent-interface'
import {
  bridgeCatalogTarget,
  bridgeRunnerSupportsModel,
  materializeBridgeModelRoute,
  qualifyBridgeProfileModel,
} from '../adapters/connections/cli-bridge-model-route.js'
import type {
  ProfileDiscoveryResult,
  ProfileRecord,
  ProfileSourceSpec,
} from '../app/profile-types.js'
import { createProfileRecord, validateProfileShape } from '../app/profiles.js'
import { compareCodeUnits } from '../domain/code-unit-order.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { BridgeModel } from './production-bridge-discovery.js'
import type { ProductionStartupLoadOptions } from './production-startup.js'

interface CompatibleBridgeModel {
  readonly route: string
  readonly runner: HarnessType
  readonly provider?: string
  readonly model: string
}

export interface ProfileProjection {
  readonly profiles: readonly ProfileRecord[]
  readonly diagnostics: readonly string[]
  readonly initialProfileId?: ProfileRecord['id']
}

export function trustedProfileSources(
  options: ProductionStartupLoadOptions,
): readonly ProfileSourceSpec[] {
  if (options.profileReference !== undefined) {
    const path = resolve(options.workspace, options.profileReference)
    return [
      {
        kind: 'file',
        path,
        reference: path,
        label: basename(path),
        writable: false,
        trusted: true,
      },
    ]
  }
  return [
    join(options.workspace, '.braid', 'profile.json'),
    join(options.workspace, 'braid.profile.json'),
  ].map((path) => ({
    kind: 'file' as const,
    path,
    reference: path,
    label: basename(path),
    writable: false,
    trusted: true,
  }))
}

function compatibleModel(model: BridgeModel): CompatibleBridgeModel | undefined {
  const candidate = bridgeCatalogTarget(model.id, model.backend)
  if (candidate === undefined) return undefined
  const profile = validateProfileShape({
    name: 'Braid model candidate',
    harness: candidate.runner,
    model: {
      default: candidate.model,
      ...(candidate.provider === undefined ? {} : { provider: candidate.provider }),
    },
  })
  if (!profile.ok || profile.profile?.harness === undefined) return undefined
  return bridgeRunnerSupportsModel(profile.profile.harness, candidate.model) ? candidate : undefined
}

function compatibleModels(models: readonly BridgeModel[]): readonly CompatibleBridgeModel[] {
  const unique = new Map<string, CompatibleBridgeModel>()
  for (const advertised of models) {
    const model = compatibleModel(advertised)
    if (model === undefined) continue
    const key = `${model.runner}\u0000${model.model}`
    unique.set(key, model)
  }
  return [...unique.values()].sort((left, right) =>
    compareCodeUnits(`${left.route}\u0000${left.runner}`, `${right.route}\u0000${right.runner}`),
  )
}

function hasRunnableTarget(profile: Readonly<AgentProfile>): boolean {
  const model = profile.model?.default?.trim()
  return (
    profile.harness !== undefined &&
    model !== undefined &&
    model.length > 0 &&
    bridgeRunnerSupportsModel(
      profile.harness,
      qualifyBridgeProfileModel(model, profile.model?.provider),
    )
  )
}

function targetKey(profile: Readonly<AgentProfile>): string | undefined {
  const runner = profile.harness
  const model = profile.model?.default?.trim()
  const provider = profile.model?.provider?.trim()
  if (runner === undefined || model === undefined || model.length === 0) {
    return undefined
  }
  return materializeBridgeModelRoute(
    runner,
    model,
    provider === undefined || provider.length === 0 ? undefined : provider,
  )
}

function generatedProfile(
  options: ProductionStartupLoadOptions,
  endpoint: string,
  candidate: CompatibleBridgeModel,
): ProfileRecord | undefined {
  const candidateProfile = {
    name: `CLI Bridge · ${candidate.runner} · ${candidate.model}`,
    description: `Advertised by the CLI Bridge model catalog at ${endpoint}.`,
    harness: candidate.runner,
    model: {
      default: candidate.model,
      ...(candidate.provider === undefined ? {} : { provider: candidate.provider }),
      ...(options.effort === undefined ? {} : { reasoningEffort: options.effort }),
    },
  }
  const validated = validateProfileShape(candidateProfile)
  if (
    !validated.ok ||
    validated.profile === undefined ||
    validated.profile.harness === undefined ||
    !bridgeRunnerSupportsModel(validated.profile.harness, candidate.model)
  ) {
    return undefined
  }
  return createProfileRecord(
    {
      kind: 'inline',
      reference: `braid:first-run-cli-bridge:${candidate.route}`,
      label: 'Advertised CLI Bridge model',
      writable: false,
      trusted: true,
    },
    validated.profile,
  )
}

function profileSort(left: ProfileRecord, right: ProfileRecord): number {
  return compareCodeUnits(
    `${left.displayName}\u0000${left.id}`,
    `${right.displayName}\u0000${right.id}`,
  )
}

/** Projects every trusted profile and every compatible live model. */
export function projectSetupProfiles(
  options: ProductionStartupLoadOptions,
  endpoint: string,
  models: readonly BridgeModel[],
  discovered: ProfileDiscoveryResult,
): ProfileProjection {
  const candidates = compatibleModels(models)
  const explicitModel = options.model?.trim()
  const explicitRunner = options.runner?.trim()
  const matching = candidates.filter(
    (candidate) =>
      (explicitModel === undefined ||
        candidate.route === explicitModel ||
        candidate.model === explicitModel) &&
      (explicitRunner === undefined || candidate.runner === explicitRunner),
  )
  const diagnostics = discovered.issues.map((issue) =>
    redactSensitiveText(`${issue.source.label}: ${issue.issue.message}`, 512),
  )
  if (
    explicitModel !== undefined &&
    !candidates.some(
      (candidate) => candidate.route === explicitModel || candidate.model === explicitModel,
    )
  ) {
    diagnostics.push(
      `Requested model ${explicitModel} was not advertised by the CLI Bridge at ${endpoint}; the full catalog remains available and any matching trusted profile will still be validated when selected`,
    )
  }
  if (
    explicitRunner !== undefined &&
    !candidates.some((candidate) => candidate.runner === explicitRunner)
  ) {
    diagnostics.push(
      `Requested runner ${explicitRunner} has no compatible advertised model at ${endpoint}; the full catalog remains available and any matching trusted profile will still be validated when selected`,
    )
  }
  if ((explicitModel !== undefined || explicitRunner !== undefined) && matching.length === 0) {
    diagnostics.push(
      `No advertised model matches the requested runner/model at ${endpoint}; choose a catalog entry or configure that bridge backend`,
    )
  }

  const trusted = discovered.profiles.filter((record) => record.source.trusted).sort(profileSort)
  const profiles: ProfileRecord[] = [...trusted]
  for (const record of trusted) {
    if (!hasRunnableTarget(record.profile)) {
      diagnostics.push(
        `Trusted profile ${redactSensitiveText(record.displayName, 256)} has no compatible runner/model pair; selecting it will remain unavailable until it is configured`,
      )
    }
  }
  const knownTargets = new Set(
    trusted
      .map((record) => targetKey(record.profile))
      .filter((key): key is string => key !== undefined),
  )
  for (const candidate of candidates) {
    const generated = generatedProfile(options, endpoint, candidate)
    if (generated === undefined) {
      diagnostics.push(
        `Advertised model ${candidate.route} could not be represented by the installed agent-interface package; it was not offered`,
      )
      continue
    }
    const key = targetKey(generated.profile)
    if (key !== undefined && knownTargets.has(key)) continue
    if (key !== undefined) knownTargets.add(key)
    profiles.push(generated)
  }
  profiles.sort(profileSort)

  const explicitProfileMatches = profiles.filter((record) => {
    const model = record.profile.model?.default
    return (
      (explicitModel === undefined ||
        model === explicitModel ||
        targetKey(record.profile) === explicitModel) &&
      (explicitRunner === undefined || record.profile.harness === explicitRunner)
    )
  })
  const initialCandidate = matching[0]
  const initial =
    (initialCandidate === undefined
      ? undefined
      : profiles.find(
          (record) =>
            record.profile.harness === initialCandidate.runner &&
            targetKey(record.profile) === initialCandidate.route,
        )) ?? explicitProfileMatches[0]
  if (profiles.length === 0) {
    diagnostics.push(
      `No trusted AgentProfile or compatible advertised model was discovered at ${endpoint}; configure a profile or start a ready CLI Bridge backend`,
    )
  } else if (!profiles.some((record) => hasRunnableTarget(record.profile))) {
    diagnostics.push(
      `No runnable runner/model pair was discovered at ${endpoint}; choose a live advertised model or repair a trusted profile before applying setup`,
    )
  }
  return {
    profiles,
    diagnostics,
    ...(initial === undefined ? {} : { initialProfileId: initial.id }),
  }
}
