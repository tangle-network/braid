import type { AgentProfile } from '@tangle-network/agent-interface'
import { AppError } from '../errors.js'
import { sha256Hex } from './learning-profile.js'
import type { LearnerSettings, LearningCandidateKind } from './learning-types.js'

/**
 * How Braid learns, as an AgentProfile of its own. `/learn` reads its settings
 * to choose what to propose and how to measure, names it in every ledger it
 * writes, and can measure and promote a changed learner the way it promotes a
 * changed agent profile: by what the learner's picks do on held-out tasks.
 */
export const LEARNER_PROFILE_NAME = 'braid-learner'
export const LEARNER_VERSION_PREFIX = 'learner.'
const EXTENSION = 'braid'

const KINDS: readonly LearningCandidateKind[] = [
  'skill',
  'workflow',
  'instructions',
  'removal',
  'subagent',
]

export const DEFAULT_LEARNER_SETTINGS: LearnerSettings = Object.freeze({
  sources: Object.freeze([
    'braid-feedback',
    'braid-task-checks',
    'claude-code-sessions',
    'codex-sessions',
    'change-ledger',
  ]),
  changes:
    'per session, with the sessions that spawned it: changed; none when the change ledger observed it; otherwise unknown',
  candidates: Object.freeze({
    kinds: Object.freeze([...KINDS]),
    maxSkills: 2,
    maxRemovals: 2,
    rowsTried: 8,
    workflowMinSessions: 2,
    maxSubagents: 2,
  }),
  measure: 'agent-eval runSkillEval; judge: check pass beats fail, otherwise tie',
  gate: 'addition: keep and worst-family success does not fall; compression: worst-family success holds at equal or fewer loaded tokens',
  seed: 1,
  concurrency: 1,
})

export function learnerProfile(settings: LearnerSettings, version?: string): AgentProfile {
  return {
    name: LEARNER_PROFILE_NAME,
    description:
      'How Braid learns: what it reads, what it proposes, how it measures and what it promotes',
    ...(version === undefined ? {} : { version }),
    extensions: { [EXTENSION]: { learning: settings as unknown as Record<string, unknown> } },
  }
}

function count(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new AppError(
      'LEARNER_PROFILE_INVALID',
      `The learner's ${name} must be a whole number from ${min} to ${max}`,
    )
  return value as number
}

/** The settings a learner profile carries, refused when any is missing or out of range. */
export function learnerSettings(profile: AgentProfile): LearnerSettings {
  const raw = profile.extensions?.[EXTENSION]?.learning as Record<string, unknown> | undefined
  if (profile.name !== LEARNER_PROFILE_NAME || raw === undefined)
    throw new AppError('LEARNER_PROFILE_INVALID', `Not a ${LEARNER_PROFILE_NAME} profile`)
  const candidates = (raw.candidates ?? {}) as Record<string, unknown>
  const kinds = candidates.kinds
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    new Set(kinds).size !== kinds.length ||
    !kinds.every((kind) => KINDS.includes(kind))
  )
    throw new AppError(
      'LEARNER_PROFILE_INVALID',
      `The learner's candidate kinds must be distinct values from ${KINDS.join(', ')}`,
    )
  const text = (value: unknown, name: string) => {
    if (typeof value !== 'string' || value === '')
      throw new AppError('LEARNER_PROFILE_INVALID', `The learner's ${name} must be text`)
    return value
  }
  const sources = raw.sources
  if (!Array.isArray(sources) || !sources.every((source) => typeof source === 'string'))
    throw new AppError('LEARNER_PROFILE_INVALID', "The learner's sources must be names")
  return {
    sources: [...sources],
    changes: text(raw.changes, 'changes'),
    candidates: {
      kinds: KINDS.filter((kind) => kinds.includes(kind)),
      maxSkills: count(candidates.maxSkills, 'maxSkills', 0, 16),
      maxRemovals: count(candidates.maxRemovals, 'maxRemovals', 0, 16),
      rowsTried: count(candidates.rowsTried, 'rowsTried', 1, 64),
      workflowMinSessions: count(candidates.workflowMinSessions, 'workflowMinSessions', 1, 100),
      maxSubagents: count(candidates.maxSubagents, 'maxSubagents', 0, 16),
    },
    measure: text(raw.measure, 'measure'),
    gate: text(raw.gate, 'gate'),
    seed: count(raw.seed, 'seed', 0, 2 ** 31),
    concurrency: count(raw.concurrency, 'concurrency', 1, 16),
  }
}

/**
 * The procedure revision every ledger names: what the learner does, not what
 * it is called. The settings are read back in their fixed order first, so the
 * digest does not depend on how they were built or stored.
 */
export function learnerDigest(settings: LearnerSettings): `sha256:${string}` {
  return `sha256:${sha256Hex(JSON.stringify(learnerSettings(learnerProfile(settings))))}`
}

export interface LearnerVariant {
  readonly name: string
  readonly summary: string
  readonly settings: LearnerSettings
}

export const MAX_LEARNER_VARIANTS = 5

/**
 * One-lever changes to the active learner: bring back a kind it dropped,
 * propose twice as many skills, or stop proposing one kind. A variant that proposes a
 * subset of the active learner's candidates costs no new selection replays.
 */
export function learnerVariants(active: LearnerSettings): LearnerVariant[] {
  const { candidates } = active
  const variants: LearnerVariant[] = []
  const withKinds = (kinds: readonly LearningCandidateKind[]): LearnerSettings => ({
    ...active,
    candidates: { ...candidates, kinds: KINDS.filter((kind) => kinds.includes(kind)) },
  })
  for (const kind of KINDS.filter((item) => !candidates.kinds.includes(item)))
    variants.push({
      name: `with-${kind}`,
      summary: `Propose ${kind} candidates again`,
      settings: withKinds([...candidates.kinds, kind]),
    })
  if (candidates.kinds.includes('skill') && candidates.maxSkills > 0 && candidates.maxSkills <= 8)
    variants.push({
      name: `skills-${candidates.maxSkills * 2}`,
      summary: `Propose up to ${candidates.maxSkills * 2} skill candidates`,
      settings: {
        ...active,
        candidates: {
          ...candidates,
          maxSkills: candidates.maxSkills * 2,
          rowsTried: Math.max(candidates.rowsTried, candidates.maxSkills * 4),
        },
      },
    })
  if (candidates.kinds.length > 1)
    for (const kind of candidates.kinds)
      variants.push({
        name: `without-${kind}`,
        summary: `Stop proposing ${kind} candidates`,
        settings: withKinds(candidates.kinds.filter((item) => item !== kind)),
      })
  return variants.slice(0, MAX_LEARNER_VARIANTS)
}
