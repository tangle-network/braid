import {
  harnessHonorsEffort,
  harnessHonorsModel,
  harnessHonorsSelectors,
  harnessReasoningEfforts,
  harnessSupportsModel,
  mergeAgentProfiles,
  preferredHarnessForModel,
  reasoningEffortsFor,
  snapHarnessToModel,
  snapModelToHarness,
  snapshotAgentProfile,
  type AgentProfile,
} from '@tangle-network/agent-interface'
import type {
  EffectiveProfileInput,
  EffectiveProfileResult,
  ProfileCompatibility,
  ProfileRunOverrides,
  ProfileSelectionCandidates,
  ProfileSelectionReason,
  ProfileSelectionResult,
  ProfileRecord,
} from './profile-types.js'

export function selectBaseProfile(
  candidates: ProfileSelectionCandidates,
): ProfileSelectionResult | undefined {
  const choices: readonly [ProfileSelectionReason, ProfileRecord | undefined][] = [
    ['command-line', candidates.commandLine],
    ['branch', candidates.branch],
    ['workspace', candidates.workspaceTrusted === true ? candidates.workspace : undefined],
    ['user', candidates.user],
    ['first-run', candidates.firstRun],
  ]
  for (const [reason, profile] of choices) {
    if (profile !== undefined) return { profile, reason }
  }
  return undefined
}

function firstDefined<T>(first: T | undefined, second: T | undefined): T | undefined {
  return first !== undefined ? first : second
}

function selectedOverrides(input: EffectiveProfileInput): ProfileRunOverrides {
  const branch = input.branchOverrides
  const next = input.nextRunOverrides
  const selected: {
    harness?: ProfileRunOverrides['harness']
    model?: ProfileRunOverrides['model']
    effort?: ProfileRunOverrides['effort']
    mode?: ProfileRunOverrides['mode']
    connectionId?: ProfileRunOverrides['connectionId']
  } = {}
  const harness = firstDefined(next?.harness, branch?.harness)
  const model = firstDefined(next?.model, branch?.model)
  const effort = firstDefined(next?.effort, branch?.effort)
  const mode = firstDefined(next?.mode, branch?.mode)
  const connectionId = firstDefined(next?.connectionId, branch?.connectionId)
  if (harness !== undefined) selected.harness = harness
  if (model !== undefined) selected.model = model
  if (effort !== undefined) selected.effort = effort
  if (mode !== undefined) selected.mode = mode
  if (connectionId !== undefined) selected.connectionId = connectionId
  return Object.freeze(selected) as ProfileRunOverrides
}

function applyProfileOverrides(
  profile: Readonly<AgentProfile>,
  overrides: ProfileRunOverrides,
): Readonly<AgentProfile> {
  const overlay: AgentProfile = {
    ...(overrides.harness === undefined ? {} : { harness: overrides.harness }),
    ...(overrides.model === undefined && overrides.effort === undefined
      ? {}
      : {
          model: {
            ...(profile.model ?? {}),
            ...(overrides.model === undefined ? {} : { default: overrides.model }),
            ...(overrides.effort === undefined ? {} : { reasoningEffort: overrides.effort }),
          },
        }),
  }
  const merged = mergeAgentProfiles(profile, overlay)
  if (merged === undefined)
    throw new Error('AgentProfile override unexpectedly produced no profile')
  return snapshotAgentProfile(merged)
}

function compatibility(
  runner: EffectiveProfileResult['runner'],
  model: string | undefined,
  input: EffectiveProfileInput,
): ProfileCompatibility {
  if (runner === undefined) return {}
  const modelSupported = model === undefined ? undefined : harnessSupportsModel(runner, model)
  const output: ProfileCompatibility = {
    ...(modelSupported === undefined ? {} : { modelSupported }),
    modelHonored: harnessHonorsModel(runner),
    effortHonored: harnessHonorsEffort(runner),
    selectorsHonored: harnessHonorsSelectors(runner),
    availableEfforts: [
      ...(model === undefined
        ? harnessReasoningEfforts(runner)
        : reasoningEffortsFor(runner, input.modelReasoning)),
    ],
  }
  if (modelSupported === false && model !== undefined) {
    const suggestedRunner = snapHarnessToModel(runner, model)
    const suggestedModel =
      input.availableModelIds === undefined
        ? undefined
        : snapModelToHarness(runner, model, input.availableModelIds)
    return {
      ...output,
      ...(suggestedRunner === runner ? {} : { suggestedRunner }),
      ...(suggestedModel === undefined || suggestedModel === model ? {} : { suggestedModel }),
    }
  }
  return output
}

export function resolveEffectiveProfile(input: EffectiveProfileInput): EffectiveProfileResult {
  const profile = input.profile.profile
  const overrides = selectedOverrides(input)
  const model = overrides.model ?? input.profile.profile.model?.default
  const effort = overrides.effort ?? input.profile.profile.model?.reasoningEffort
  const runner =
    overrides.harness ??
    input.branchOverrides?.harness ??
    profile.harness ??
    (model === undefined ? undefined : (preferredHarnessForModel(model) ?? undefined))
  const mode = overrides.mode ?? input.branchOverrides?.mode
  const connectionId =
    overrides.connectionId ??
    input.branchOverrides?.connectionId ??
    (input.workspaceTrusted === true ? input.workspaceConnectionId : undefined) ??
    input.userConnectionId
  const effectiveProfile = applyProfileOverrides(profile, overrides)
  return Object.freeze({
    authoredProfile: profile,
    effectiveProfile,
    ...(runner === undefined ? {} : { runner }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(mode === undefined ? {} : { mode }),
    ...(connectionId === undefined ? {} : { connectionId }),
    overrides,
    compatibility: compatibility(runner, model, input),
  })
}
