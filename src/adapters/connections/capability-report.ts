import type {
  AgentEnvironmentCapabilities,
  AgentExactProcessEgressMode,
  AgentProfile,
  AgentProfileCapabilities,
  ModelReasoningCapability,
} from '@tangle-network/agent-interface'
import { harnessTypeSchema, reasoningLadder } from '@tangle-network/agent-interface'
import {
  type ConnectionCapabilitySnapshot,
  withCapabilityDigest,
} from '../../connection/connections.js'
import {
  containsControlCharacters,
  containsSecretShape,
  redactProviderText,
} from '../../connection/redaction.js'
import { cloneBoundedProfileValue, type ProfileJsonLimits } from '../../profile/profile-json.js'

/**
 * Structural validation of a provider capability report.
 *
 * The canonical package owns the capability TYPE but ships no runtime validator
 * for it, so an unvalidated payload lets `environment.profile: "bad"` or
 * `streaming: null` through and every later capability check silently reads
 * `undefined` as permissive. Each field below is checked against the canonical
 * type; `tsc` fails here if the canonical shape gains a field, so this validator
 * cannot drift into a looser private copy.
 */

const MAX_MODELS = 4_096
const MAX_RUNNERS = 64
const MAX_EXTENSIONS = 256
const CAPABILITY_LIMITS: ProfileJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 32,
  maxNodes: 30_000,
  maxStringLength: 4_096,
  maxEntries: 4_096,
})

export class ProviderCapabilityError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    const safePath = redactProviderText(path, 256) ?? '<unknown>'
    const safeMessage = redactProviderText(message, 512) ?? 'is invalid'
    super(`Provider capability ${safePath} ${safeMessage}`)
    this.name = 'ProviderCapabilityError'
    this.path = safePath
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderCapabilityError(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ProviderCapabilityError(path, 'must be a boolean')
  return value
}

function optionalBool(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  return bool(value, path)
}

function boundedStrings(value: unknown, path: string, max: number): readonly string[] {
  if (!Array.isArray(value)) throw new ProviderCapabilityError(path, 'must be an array')
  if (value.length > max) throw new ProviderCapabilityError(path, `has more than ${max} entries`)
  return Object.freeze(
    value.map((entry, index) => {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > 512) {
        throw new ProviderCapabilityError(`${path}.${index}`, 'must be a bounded non-empty string')
      }
      if (
        containsControlCharacters(entry) ||
        /\p{Bidi_Control}/u.test(entry) ||
        containsSecretShape(entry)
      ) {
        throw new ProviderCapabilityError(
          `${path}.${index}`,
          'must not contain control or secret material',
        )
      }
      return entry
    }),
  )
}

function profileCapabilities(value: unknown, path: string): AgentProfileCapabilities {
  const source = record(value, path)
  const resources = record(source.resources, `${path}.resources`)
  const extensions =
    source.extensions === undefined
      ? undefined
      : boundedStrings(source.extensions, `${path}.extensions`, MAX_EXTENSIONS)
  const hooks = optionalBool(source.hooks, `${path}.hooks`)
  const modes = optionalBool(source.modes, `${path}.modes`)
  const resourceTools = optionalBool(resources.tools, `${path}.resources.tools`)
  const resourceSkills = optionalBool(resources.skills, `${path}.resources.skills`)
  const resourceAgents = optionalBool(resources.agents, `${path}.resources.agents`)
  const resourceCommands = optionalBool(resources.commands, `${path}.resources.commands`)
  return Object.freeze({
    namedProfiles: bool(source.namedProfiles, `${path}.namedProfiles`),
    systemPrompt: bool(source.systemPrompt, `${path}.systemPrompt`),
    instructions: bool(source.instructions, `${path}.instructions`),
    tools: bool(source.tools, `${path}.tools`),
    permissions: bool(source.permissions, `${path}.permissions`),
    mcp: bool(source.mcp, `${path}.mcp`),
    subagents: bool(source.subagents, `${path}.subagents`),
    resources: Object.freeze({
      files: bool(resources.files, `${path}.resources.files`),
      instructions: bool(resources.instructions, `${path}.resources.instructions`),
      ...(resourceTools === undefined ? {} : { tools: resourceTools }),
      ...(resourceSkills === undefined ? {} : { skills: resourceSkills }),
      ...(resourceAgents === undefined ? {} : { agents: resourceAgents }),
      ...(resourceCommands === undefined ? {} : { commands: resourceCommands }),
    }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(modes === undefined ? {} : { modes }),
    runtimeUpdate: bool(source.runtimeUpdate, `${path}.runtimeUpdate`),
    validation: bool(source.validation, `${path}.validation`),
    ...(extensions === undefined ? {} : { extensions: [...extensions] }),
  })
}

function environmentCapabilities(value: unknown): AgentEnvironmentCapabilities {
  const source = record(value, 'environment')
  const streaming = record(source.streaming, 'environment.streaming')
  const sessions = record(source.sessions, 'environment.sessions')
  const workspace = record(source.workspace, 'environment.workspace')
  const branching = record(source.branching, 'environment.branching')
  const exactProcess =
    source.exactProcess === undefined
      ? undefined
      : record(source.exactProcess, 'environment.exactProcess')
  return Object.freeze({
    profile: profileCapabilities(source.profile, 'environment.profile'),
    streaming: Object.freeze({
      live: bool(streaming.live, 'environment.streaming.live'),
      replay: bool(streaming.replay, 'environment.streaming.replay'),
      detach: bool(streaming.detach, 'environment.streaming.detach'),
      turnIdempotency: bool(streaming.turnIdempotency, 'environment.streaming.turnIdempotency'),
    }),
    sessions: Object.freeze({
      continue: bool(sessions.continue, 'environment.sessions.continue'),
      list: bool(sessions.list, 'environment.sessions.list'),
      messages: bool(sessions.messages, 'environment.sessions.messages'),
    }),
    workspace: Object.freeze({
      read: bool(workspace.read, 'environment.workspace.read'),
      write: bool(workspace.write, 'environment.workspace.write'),
      exec: bool(workspace.exec, 'environment.workspace.exec'),
      git: bool(workspace.git, 'environment.workspace.git'),
      upload: bool(workspace.upload, 'environment.workspace.upload'),
      download: bool(workspace.download, 'environment.workspace.download'),
    }),
    branching: Object.freeze({
      checkpoint: bool(branching.checkpoint, 'environment.branching.checkpoint'),
      fork: bool(branching.fork, 'environment.branching.fork'),
    }),
    placement: bool(source.placement, 'environment.placement'),
    usage: bool(source.usage, 'environment.usage'),
    confidential: bool(source.confidential, 'environment.confidential'),
    ...(exactProcess === undefined
      ? {}
      : { exactProcess: Object.freeze({ egress: egressModes(exactProcess.egress) }) }),
  })
}

const EGRESS_MODES: readonly AgentExactProcessEgressMode[] = Object.freeze(['blocked', 'strict'])

function egressModes(value: unknown): readonly AgentExactProcessEgressMode[] {
  const modes = boundedStrings(value, 'environment.exactProcess.egress', EGRESS_MODES.length).map(
    (candidate) => {
      if (!EGRESS_MODES.includes(candidate as AgentExactProcessEgressMode)) {
        throw new ProviderCapabilityError(
          'environment.exactProcess.egress',
          `reported the unknown mode ${candidate}`,
        )
      }
      return candidate as AgentExactProcessEgressMode
    },
  )
  if (new Set(modes).size !== modes.length) {
    throw new ProviderCapabilityError('environment.exactProcess.egress', 'contains duplicates')
  }
  return Object.freeze(modes)
}

function modelReasoning(value: unknown): Readonly<Record<string, ModelReasoningCapability>> {
  if (value === undefined) return Object.freeze({})
  const source = record(value, 'modelReasoning')
  const entries = Object.entries(source)
  if (entries.length > MAX_MODELS) {
    throw new ProviderCapabilityError('modelReasoning', `has more than ${MAX_MODELS} entries`)
  }
  const material: Record<string, ModelReasoningCapability> = {}
  for (const [model, candidate] of entries) {
    if (
      model.length === 0 ||
      model.length > 512 ||
      containsControlCharacters(model) ||
      /\p{Bidi_Control}/u.test(model)
    ) {
      throw new ProviderCapabilityError(`modelReasoning.${model}`, 'has an invalid model id')
    }
    const details = record(candidate, `modelReasoning.${model}`)
    const supportsReasoning = optionalBool(
      details.supportsReasoning,
      `modelReasoning.${model}.supportsReasoning`,
    )
    let maxEffort: (typeof reasoningLadder)[number] | undefined
    if (details.maxEffort !== undefined) {
      if (
        typeof details.maxEffort !== 'string' ||
        !reasoningLadder.includes(details.maxEffort as (typeof reasoningLadder)[number])
      ) {
        throw new ProviderCapabilityError(
          `modelReasoning.${model}.maxEffort`,
          'must be a canonical reasoning effort',
        )
      }
      maxEffort = details.maxEffort as (typeof reasoningLadder)[number]
    }
    Object.defineProperty(material, model, {
      value: Object.freeze({
        ...(supportsReasoning === undefined ? {} : { supportsReasoning }),
        ...(maxEffort === undefined ? {} : { maxEffort }),
      }),
      enumerable: true,
    })
  }
  return Object.freeze(material)
}

/** Validate a whole capability payload into an immutable snapshot. */
export function readCapabilitySnapshot(
  payload: unknown,
  retrievedAt: string,
  source: string,
): ConnectionCapabilitySnapshot {
  if (typeof retrievedAt !== 'string' || Number.isNaN(Date.parse(retrievedAt))) {
    throw new ProviderCapabilityError('retrievedAt', 'must be an ISO timestamp')
  }
  if (typeof source !== 'string') {
    throw new ProviderCapabilityError('source', 'must be a string')
  }
  let bounded: unknown
  try {
    bounded = cloneBoundedProfileValue(payload, CAPABILITY_LIMITS)
  } catch (error) {
    throw new ProviderCapabilityError(
      'response',
      error instanceof Error ? error.message : 'has an invalid bounded shape',
    )
  }
  const value = record(bounded, 'response')
  const snapshotShape = Object.hasOwn(value, 'supportedRunners') || Object.hasOwn(value, 'modelIds')
  const wireShape = Object.hasOwn(value, 'runners') || Object.hasOwn(value, 'models')
  if (snapshotShape && wireShape) {
    throw new ProviderCapabilityError(
      'response',
      'must not mix wire and normalized capability fields',
    )
  }
  const environment = environmentCapabilities(value.environment ?? value.capabilities)
  const runners = boundedStrings(
    snapshotShape ? value.supportedRunners : value.runners,
    snapshotShape ? 'supportedRunners' : 'runners',
    MAX_RUNNERS,
  ).map((candidate) => {
    const parsed = harnessTypeSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new ProviderCapabilityError(
        snapshotShape ? 'supportedRunners' : 'runners',
        `reported the unknown runner ${candidate}`,
      )
    }
    return parsed.data
  })
  const models = boundedStrings(
    snapshotShape ? value.modelIds : value.models,
    snapshotShape ? 'modelIds' : 'models',
    MAX_MODELS,
  )
  if (new Set(runners).size !== runners.length) {
    throw new ProviderCapabilityError('runners', 'contains duplicate runner ids')
  }
  if (new Set(models).size !== models.length) {
    throw new ProviderCapabilityError('models', 'contains duplicate model ids')
  }
  const normalizedRetrievedAt = Object.hasOwn(value, 'retrievedAt')
    ? value.retrievedAt
    : retrievedAt
  if (
    typeof normalizedRetrievedAt !== 'string' ||
    Number.isNaN(Date.parse(normalizedRetrievedAt))
  ) {
    throw new ProviderCapabilityError('retrievedAt', 'must be an ISO timestamp')
  }
  const normalized = withCapabilityDigest({
    environment,
    supportedRunners: Object.freeze(runners),
    modelIds: Object.freeze([...models]),
    modelReasoning: modelReasoning(value.modelReasoning),
    retrievedAt: normalizedRetrievedAt,
    source: redactProviderText(source, 256) ?? 'provider',
  })
  if (value.digest !== undefined && value.digest !== normalized.digest) {
    throw new ProviderCapabilityError('digest', 'does not match the complete capability snapshot')
  }
  return normalized
}

/**
 * Profile dimensions the reported capabilities cannot honor.
 *
 * This is derived from the capability report rather than assumed absent when the
 * provider offers no validation endpoint: a bridge that reports `hooks: false`
 * must block a hook-bearing profile even when it exposes nothing to ask.
 */
export function unsupportedProfileDimensions(
  capabilities: AgentProfileCapabilities,
  profile: Readonly<AgentProfile>,
  options: { readonly providerCatalogReference?: boolean } = {},
): readonly string[] {
  const unsupported: string[] = []
  const requires = (present: boolean, supported: boolean | undefined, dimension: string): void => {
    if (present && supported !== true) unsupported.push(dimension)
  }
  requires(
    options.providerCatalogReference === true && profile.name !== undefined,
    capabilities.namedProfiles,
    'name',
  )
  requires(
    profile.prompt?.systemPrompt !== undefined,
    capabilities.systemPrompt,
    'prompt.systemPrompt',
  )
  requires(
    (profile.prompt?.instructions?.length ?? 0) > 0,
    capabilities.instructions,
    'prompt.instructions',
  )
  requires(profile.tools !== undefined, capabilities.tools, 'tools')
  requires(profile.permissions !== undefined, capabilities.permissions, 'permissions')
  requires(profile.mcp !== undefined, capabilities.mcp, 'mcp')
  requires(profile.subagents !== undefined, capabilities.subagents, 'subagents')
  requires(
    (profile.resources?.files?.length ?? 0) > 0,
    capabilities.resources.files,
    'resources.files',
  )
  requires(
    profile.resources?.instructions !== undefined,
    capabilities.resources.instructions,
    'resources.instructions',
  )
  requires(
    (profile.resources?.tools?.length ?? 0) > 0,
    capabilities.resources.tools,
    'resources.tools',
  )
  requires(
    (profile.resources?.skills?.length ?? 0) > 0,
    capabilities.resources.skills,
    'resources.skills',
  )
  requires(
    (profile.resources?.agents?.length ?? 0) > 0,
    capabilities.resources.agents,
    'resources.agents',
  )
  requires(
    (profile.resources?.commands?.length ?? 0) > 0,
    capabilities.resources.commands,
    'resources.commands',
  )
  requires(profile.hooks !== undefined, capabilities.hooks, 'hooks')
  requires(profile.modes !== undefined, capabilities.modes, 'modes')
  for (const namespace of Object.keys(profile.extensions ?? {})) {
    if (!(capabilities.extensions ?? []).includes(namespace)) {
      unsupported.push(`extensions.${namespace}`)
    }
  }
  return Object.freeze(unsupported)
}
