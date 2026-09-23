import {
  harnessTypeSchema,
  reasoningLadder,
} from '@tangle-network/agent-interface'
import { containsControlCharacters, containsSecretShape } from './redaction.js'

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const MAX_STRINGS = 4_096

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Capability ${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const known = new Set(allowed)
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new Error(`Capability ${path} contains an unsupported field`)
  }
}

function boolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') throw new Error(`Capability ${path} must be a boolean`)
}

function optionalBoolean(value: unknown, path: string): void {
  if (value !== undefined) boolean(value, path)
}

function strings(value: unknown, path: string, limit = MAX_STRINGS): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`Capability ${path} must be an array`)
  if (value.length > limit) throw new Error(`Capability ${path} has too many entries`)
  const result = value.map((entry, index) => {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > 512 ||
      containsControlCharacters(entry) ||
      /\p{Bidi_Control}/u.test(entry) ||
      containsSecretShape(entry)
    ) {
      throw new Error(`Capability ${path}.${index} is not a safe bounded string`)
    }
    return entry
  })
  if (new Set(result).size !== result.length) {
    throw new Error(`Capability ${path} contains duplicates`)
  }
  return result
}

function profileCapabilities(value: unknown): void {
  const profile = record(value, 'environment.profile')
  keys(
    profile,
    [
      'namedProfiles',
      'systemPrompt',
      'instructions',
      'tools',
      'permissions',
      'mcp',
      'subagents',
      'resources',
      'hooks',
      'modes',
      'runtimeUpdate',
      'validation',
      'extensions',
    ],
    'environment.profile',
  )
  for (const key of [
    'namedProfiles',
    'systemPrompt',
    'instructions',
    'tools',
    'permissions',
    'mcp',
    'subagents',
    'runtimeUpdate',
    'validation',
  ]) {
    boolean(profile[key], `environment.profile.${key}`)
  }
  optionalBoolean(profile.hooks, 'environment.profile.hooks')
  optionalBoolean(profile.modes, 'environment.profile.modes')
  if (profile.extensions !== undefined) strings(profile.extensions, 'environment.profile.extensions', 256)
  const resources = record(profile.resources, 'environment.profile.resources')
  keys(
    resources,
    ['files', 'instructions', 'tools', 'skills', 'agents', 'commands'],
    'environment.profile.resources',
  )
  boolean(resources.files, 'environment.profile.resources.files')
  boolean(resources.instructions, 'environment.profile.resources.instructions')
  for (const key of ['tools', 'skills', 'agents', 'commands']) {
    optionalBoolean(resources[key], `environment.profile.resources.${key}`)
  }
}

function environmentCapabilities(value: unknown): void {
  const environment = record(value, 'environment')
  keys(
    environment,
    [
      'profile',
      'streaming',
      'sessions',
      'workspace',
      'branching',
      'placement',
      'usage',
      'confidential',
      'exactProcess',
    ],
    'environment',
  )
  profileCapabilities(environment.profile)
  for (const [group, fields] of [
    ['streaming', ['live', 'replay', 'detach', 'turnIdempotency']],
    ['sessions', ['continue', 'list', 'messages']],
    ['workspace', ['read', 'write', 'exec', 'git', 'upload', 'download']],
    ['branching', ['checkpoint', 'fork']],
  ] as const) {
    const section = record(environment[group], `environment.${group}`)
    keys(section, fields, `environment.${group}`)
    for (const field of fields) boolean(section[field], `environment.${group}.${field}`)
  }
  boolean(environment.placement, 'environment.placement')
  boolean(environment.usage, 'environment.usage')
  boolean(environment.confidential, 'environment.confidential')
  if (environment.exactProcess !== undefined) {
    const exactProcess = record(environment.exactProcess, 'environment.exactProcess')
    keys(exactProcess, ['egress'], 'environment.exactProcess')
    const egress = strings(exactProcess.egress, 'environment.exactProcess.egress', 2)
    if (egress.some((mode) => mode !== 'blocked' && mode !== 'strict')) {
      throw new Error('Capability environment.exactProcess.egress has an unknown mode')
    }
  }
}

function modelReasoning(value: unknown): void {
  const source = record(value, 'modelReasoning')
  if (Object.keys(source).length > MAX_STRINGS) {
    throw new Error('Capability modelReasoning has too many entries')
  }
  for (const [model, candidate] of Object.entries(source)) {
    if (
      model.length === 0 ||
      model.length > 512 ||
      containsControlCharacters(model) ||
      /\p{Bidi_Control}/u.test(model) ||
      containsSecretShape(model)
    ) {
      throw new Error(`Capability modelReasoning.${model} has an invalid model id`)
    }
    const details = record(candidate, `modelReasoning.${model}`)
    keys(details, ['supportsReasoning', 'maxEffort'], `modelReasoning.${model}`)
    optionalBoolean(details.supportsReasoning, `modelReasoning.${model}.supportsReasoning`)
    if (details.maxEffort !== undefined &&
      (typeof details.maxEffort !== 'string' ||
        !reasoningLadder.includes(details.maxEffort as (typeof reasoningLadder)[number]))) {
      throw new Error(`Capability modelReasoning.${model}.maxEffort is not canonical`)
    }
  }
}

/** Validate a provider-normalized snapshot before it is hashed or exposed. */
export function validateNormalizedCapabilityShape(value: unknown): void {
  const snapshot = record(value, 'snapshot')
  const allowed = [
    'environment',
    'supportedRunners',
    'modelIds',
    'modelReasoning',
    'retrievedAt',
    'source',
    'digest',
  ]
  keys(snapshot, allowed, 'snapshot')
  environmentCapabilities(snapshot.environment)
  const runners = strings(snapshot.supportedRunners, 'supportedRunners', 64)
  for (const runner of runners) {
    if (!harnessTypeSchema.safeParse(runner).success) {
      throw new Error(`Capability supportedRunners contains an unknown runner ${runner}`)
    }
  }
  strings(snapshot.modelIds, 'modelIds')
  modelReasoning(snapshot.modelReasoning)
  if (typeof snapshot.retrievedAt !== 'string' || Number.isNaN(Date.parse(snapshot.retrievedAt))) {
    throw new Error('Capability retrievedAt must be an ISO timestamp')
  }
  if (
    typeof snapshot.source !== 'string' ||
    snapshot.source.length === 0 ||
    snapshot.source.length > 256 ||
    containsControlCharacters(snapshot.source) ||
    containsSecretShape(snapshot.source)
  ) {
    throw new Error('Capability source must be bounded text')
  }
  if (snapshot.digest !== undefined &&
    (typeof snapshot.digest !== 'string' || !DIGEST_PATTERN.test(snapshot.digest))) {
    throw new Error('Capability digest is invalid')
  }
}
