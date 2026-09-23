import {
  type AgentProfile,
  type AgentProfileCapabilities,
  type AgentProfileMode,
  type HarnessType,
  harnessHonorsEffort,
  harnessHonorsModel,
  harnessSupportsModel,
  type ModelReasoningCapability,
  mergeAgentProfiles,
  preferredHarnessForModel,
  type ReasoningEffort,
  reasoningEffortsFor,
  reasoningLadder,
  snapModelToHarness,
  snapshotAgentProfile,
} from '@tangle-network/agent-interface'

export interface RunOverrides {
  readonly runner?: HarnessType
  readonly model?: string
  readonly effort?: ReasoningEffort
  readonly mode?: string
}

export interface SelectionLayers {
  readonly nextRun?: RunOverrides
  readonly branch?: RunOverrides
  readonly workspace?: RunOverrides
  readonly user?: RunOverrides
}

export interface RunnerCapabilityCatalog {
  readonly supportedRunners: readonly HarnessType[]
  readonly modelIds: readonly string[]
  readonly modelReasoning: Readonly<Record<string, ModelReasoningCapability>>
  /** Omitted when no connection is selected; capability-gated dimensions then remain unevaluated. */
  readonly profileCapabilities?: Readonly<AgentProfileCapabilities>
}

export type SelectionFidelity = 'exact' | 'snapped' | 'ignored' | 'unsupported' | 'unset'
export type SelectionSource =
  | 'next-run'
  | 'branch'
  | 'workspace'
  | 'user'
  | 'profile'
  | 'canonical'
  | 'none'

export interface EffectiveSelection<T> {
  readonly requested?: T
  readonly effective?: T
  readonly source: SelectionSource
  readonly fidelity: SelectionFidelity
  readonly reason?: string
}

export interface EffectiveRunSelection {
  readonly runner: EffectiveSelection<HarnessType>
  readonly model: EffectiveSelection<string>
  readonly effort: EffectiveSelection<ReasoningEffort>
  readonly mode: EffectiveSelection<string>
  readonly profile: Readonly<AgentProfile>
}

export interface ProfileSelectionLayers {
  readonly explicit?: string
  readonly branch?: string
  readonly trustedWorkspace?: string
  readonly user?: string
  readonly firstRun?: string
}

export interface SelectedProfileReference {
  readonly reference: string
  readonly source: 'command-line' | 'branch' | 'workspace' | 'user' | 'first-run'
}

export function selectProfileReference(
  layers: ProfileSelectionLayers,
): SelectedProfileReference | undefined {
  const candidates: readonly [SelectedProfileReference['source'], string | undefined][] = [
    ['command-line', layers.explicit],
    ['branch', layers.branch],
    ['workspace', layers.trustedWorkspace],
    ['user', layers.user],
    ['first-run', layers.firstRun],
  ]
  for (const [source, reference] of candidates) {
    if (reference !== undefined) return Object.freeze({ reference, source })
  }
  return undefined
}

function firstDefined<T>(
  layers: readonly [SelectionSource, RunOverrides | undefined][],
  key: keyof RunOverrides,
): { readonly source: SelectionSource; readonly value: T } | undefined {
  for (const [source, layer] of layers) {
    const value = layer?.[key]
    if (value !== undefined) return { source, value: value as T }
  }
  return undefined
}

function unsupported<T>(
  requested: T | undefined,
  source: SelectionSource,
  reason: string,
): EffectiveSelection<T> {
  return Object.freeze({
    ...(requested === undefined ? {} : { requested }),
    source,
    fidelity: 'unsupported' as const,
    reason,
  })
}

function unset<T>(): EffectiveSelection<T> {
  return Object.freeze({ source: 'none' as const, fidelity: 'unset' as const })
}

function availableModelCapability(
  catalog: RunnerCapabilityCatalog,
  model: string | undefined,
): ModelReasoningCapability | undefined {
  return model === undefined ? undefined : catalog.modelReasoning[model]
}

function resolveRunner(
  profile: AgentProfile,
  layers: SelectionLayers,
  catalog: RunnerCapabilityCatalog,
): EffectiveSelection<HarnessType> {
  const explicit = firstDefined<HarnessType>(
    [
      ['next-run', layers.nextRun],
      ['branch', layers.branch],
      ['workspace', layers.workspace],
      ['user', layers.user],
    ],
    'runner',
  )
  const requested = explicit?.value ?? profile.harness
  const source = explicit?.source ?? (profile.harness === undefined ? 'canonical' : 'profile')
  const model =
    firstDefined<string>(
      [
        ['next-run', layers.nextRun],
        ['branch', layers.branch],
        ['workspace', layers.workspace],
        ['user', layers.user],
      ],
      'model',
    )?.value ?? profile.model?.default
  const preferred = model === undefined ? null : preferredHarnessForModel(model)
  const runner = requested ?? preferred ?? undefined
  if (runner !== undefined) {
    if (catalog.supportedRunners.includes(runner)) {
      return Object.freeze({ requested: runner, effective: runner, source, fidelity: 'exact' })
    }
    return unsupported(
      runner,
      source,
      `Runner ${runner} is not reported by the selected connection`,
    )
  }
  // A null canonical preference is router-backed; choose a reported runner that carries the model.
  if (model === undefined) return unset()
  const routed = catalog.supportedRunners.find((candidate) =>
    harnessSupportsModel(candidate, model),
  )
  if (routed === undefined) {
    return unsupported<HarnessType>(
      undefined,
      'canonical',
      `No runner reported by the selected connection can run ${model}`,
    )
  }
  return Object.freeze({
    effective: routed,
    source: 'canonical',
    fidelity: 'snapped',
    reason: `Canonical helper routed ${model} to ${routed}`,
  })
}

function resolveModel(
  profile: AgentProfile,
  layers: SelectionLayers,
  runner: EffectiveSelection<HarnessType>,
  catalog: RunnerCapabilityCatalog,
): EffectiveSelection<string> {
  const explicit = firstDefined<string>(
    [
      ['next-run', layers.nextRun],
      ['branch', layers.branch],
      ['workspace', layers.workspace],
      ['user', layers.user],
    ],
    'model',
  )
  const requested = explicit?.value ?? profile.model?.default
  if (requested === undefined) return unset()
  const source =
    explicit?.source ?? (profile.model?.default === undefined ? 'canonical' : 'profile')
  if (runner.effective === undefined) {
    return unsupported(requested, source, 'A supported runner is required before choosing a model')
  }
  if (!harnessHonorsModel(runner.effective)) {
    return Object.freeze({
      requested,
      source,
      fidelity: 'ignored',
      reason: 'The selected runner chooses its own model',
    })
  }
  if (harnessSupportsModel(runner.effective, requested) && catalog.modelIds.includes(requested)) {
    return Object.freeze({ requested, effective: requested, source, fidelity: 'exact' })
  }
  if (catalog.modelIds.length === 0) {
    return unsupported(requested, source, 'The connection reported no model catalog')
  }
  const snapped = snapModelToHarness(runner.effective, requested, catalog.modelIds)
  if (!catalog.modelIds.includes(snapped)) {
    return unsupported(
      requested,
      source,
      `Model ${requested} is not supported by runner ${runner.effective}`,
    )
  }
  return Object.freeze({
    requested,
    effective: snapped,
    source,
    fidelity: snapped === requested ? 'exact' : 'snapped',
    ...(snapped === requested ? {} : { reason: `Canonical helper selected ${snapped}` }),
  })
}

function resolveEffort(
  profile: AgentProfile,
  layers: SelectionLayers,
  runner: EffectiveSelection<HarnessType>,
  model: EffectiveSelection<string>,
  catalog: RunnerCapabilityCatalog,
): EffectiveSelection<ReasoningEffort> {
  const explicit = firstDefined<ReasoningEffort>(
    [
      ['next-run', layers.nextRun],
      ['branch', layers.branch],
      ['workspace', layers.workspace],
      ['user', layers.user],
    ],
    'effort',
  )
  const requested = explicit?.value ?? profile.model?.reasoningEffort
  if (requested === undefined) return unset()
  const source =
    explicit?.source ?? (profile.model?.reasoningEffort === undefined ? 'canonical' : 'profile')
  if (runner.effective === undefined) {
    return unsupported(requested, source, 'A supported runner is required before choosing effort')
  }
  if (!harnessHonorsEffort(runner.effective)) {
    return Object.freeze({
      requested,
      source,
      fidelity: 'ignored',
      reason: 'The selected runner ignores effort',
    })
  }
  const available = reasoningEffortsFor(
    runner.effective,
    availableModelCapability(catalog, model.effective ?? model.requested),
  )
  if (available.includes(requested)) {
    return Object.freeze({ requested, effective: requested, source, fidelity: 'exact' })
  }
  const requestedIndex = reasoningLadder.indexOf(requested)
  const lower = available
    .filter((candidate) => reasoningLadder.indexOf(candidate) <= requestedIndex)
    .at(-1)
  if (lower === undefined) {
    return unsupported(
      requested,
      source,
      `Runner ${runner.effective} cannot honor effort ${requested}`,
    )
  }
  return Object.freeze({
    requested,
    effective: lower,
    source,
    fidelity: 'snapped',
    reason: `Canonical helper limited effort to ${lower}`,
  })
}

/** Resolve a declared mode and apply its canonical fields to the effective snapshot. */
function resolveMode(
  profile: AgentProfile,
  layers: SelectionLayers,
  capabilities: { readonly modes?: boolean } | undefined,
): EffectiveSelection<string> {
  const explicit = firstDefined<string>(
    [
      ['next-run', layers.nextRun],
      ['branch', layers.branch],
      ['workspace', layers.workspace],
      ['user', layers.user],
    ],
    'mode',
  )
  if (explicit === undefined) return unset()
  const declared = profile.modes ?? {}
  if (!Object.hasOwn(declared, explicit.value)) {
    const available = Object.keys(declared)
    return unsupported(
      explicit.value,
      explicit.source,
      available.length === 0
        ? `The profile declares no modes, so ${explicit.value} cannot be selected`
        : `The profile does not declare mode ${explicit.value}; it declares ${available.join(', ')}`,
    )
  }
  if (capabilities !== undefined && capabilities.modes !== true) {
    return unsupported(
      explicit.value,
      explicit.source,
      'The selected connection does not report support for profile modes',
    )
  }
  return Object.freeze({
    requested: explicit.value,
    effective: explicit.value,
    source: explicit.source,
    fidelity: 'exact',
  })
}

/** Canonical fields one mode contributes to the effective profile. */
function modeOverlay(mode: AgentProfileMode): AgentProfile {
  return {
    ...(mode.prompt === undefined ? {} : { prompt: { systemPrompt: mode.prompt } }),
    ...(mode.model === undefined ? {} : { model: { default: mode.model } }),
    ...(mode.tools === undefined ? {} : { tools: { ...mode.tools } }),
    ...(mode.permissions === undefined ? {} : { permissions: { ...mode.permissions } }),
  }
}

export function resolveEffectiveRun(
  profile: AgentProfile,
  layers: SelectionLayers,
  catalog: RunnerCapabilityCatalog,
): EffectiveRunSelection {
  const mode = resolveMode(profile, layers, catalog.profileCapabilities)
  // Fold mode fields in before runner/model/effort resolution.
  const selected = mode.effective === undefined ? undefined : profile.modes?.[mode.effective]
  const authored =
    selected === undefined
      ? profile
      : (mergeAgentProfiles(profile, modeOverlay(selected)) ?? profile)
  const runner = resolveRunner(authored, layers, catalog)
  const model = resolveModel(authored, layers, runner, catalog)
  const effort = resolveEffort(authored, layers, runner, model, catalog)
  const overlay: AgentProfile = {
    ...authored,
    ...(runner.effective === undefined || runner.fidelity === 'ignored'
      ? {}
      : { harness: runner.effective }),
    ...(model.effective === undefined && effort.effective === undefined
      ? {}
      : {
          model: {
            ...(authored.model ?? {}),
            ...(model.effective === undefined ? {} : { default: model.effective }),
            ...(effort.effective === undefined ? {} : { reasoningEffort: effort.effective }),
          },
        }),
  }
  const effectiveProfile = snapshotAgentProfile(overlay)
  return Object.freeze({ runner, model, effort, mode, profile: effectiveProfile })
}
/** Every selected dimension, in the order a confirmation view reports them. */
export function selectionDimensions(
  selection: EffectiveRunSelection,
): readonly EffectiveSelection<string>[] {
  return Object.freeze([
    selection.runner as EffectiveSelection<string>,
    selection.model,
    selection.effort as EffectiveSelection<string>,
    selection.mode,
  ])
}

export function selectionHasBlockingUnsupportedValue(selection: EffectiveRunSelection): boolean {
  return selectionDimensions(selection).some((value) => value.fidelity === 'unsupported')
}
