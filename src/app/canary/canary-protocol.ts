/**
 * The randomized canary of learned procedure packs.
 *
 * A delegated task brief is the assignment unit and the repository it changes
 * is the cluster. Control gets the brief as written; candidate gets the brief
 * followed by the pack Braid learned from the named skill's past sessions.
 * Both arms carry one line that the task's pull requests repeat, so the
 * outcome checker can find them.
 *
 * The protocol is sealed into the ledger's first entry before any assignment:
 * the eligibility rule, the randomizer's seed commitment, every pack's digest,
 * the served revision, the outcome checker, the cutoff and the maturity. The
 * analysis rule inside it is sealed by agent-eval, so the readout's decision
 * refuses any protocol other than this one.
 */

import { createHmac } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RandomizedCanaryRule } from '@tangle-network/agent-eval/experiment'
import { canonicalJson } from '../../domain/canonical.js'
import { AppError } from '../errors.js'
import {
  type AssignmentEntry,
  appendLedger,
  type CanaryArm,
  type LedgerEntry,
  type ProtocolEntry,
  readLedger,
  canaryDigest,
  syncLedger,
} from './canary-ledger.js'

export const PROTOCOL_SCHEMA = 'braid.canary-protocol.v1'
export const ASSIGNMENT_LINE_PREFIX = 'Braid-Assignment:'

/** What the operator writes; Braid adds the digests it can compute and seals the rest. */
export interface CanaryProtocolInput {
  readonly experimentId: string
  readonly question: string
  /** The eligibility rule in words, beyond what Braid enforces: which briefs are routed here. */
  readonly eligibility: { readonly unit: string; readonly repositoryCap: number }
  readonly served: { readonly braidVersion: string; readonly braidCommit: string }
  /** The registered outcome: its definition, the checker's revision and digest. */
  readonly outcome: Readonly<Record<string, unknown>> & { readonly checkerDigest: string }
  readonly secondary?: Readonly<Record<string, unknown>>
  readonly power?: Readonly<Record<string, unknown>>
  readonly readoutAt: string
  /** The analysis rule's registered fields; Braid supplies every digest field. */
  readonly analysis: Omit<
    RandomizedCanaryRule,
    | 'experimentId'
    | 'eligibilityRuleDigest'
    | 'controlProfileDigest'
    | 'candidateProfileDigest'
    | 'servedCodeRevisionDigest'
    | 'outcomeCheckerDigest'
    | 'assignmentUnit'
    | 'clusterUnit'
  >
}

/** The pack set a seal freezes: one file per skill, named by its digest. */
export interface PackManifest {
  readonly skills: Readonly<Record<string, { readonly file: string; readonly digest: string }>>
}

export interface CanaryConfig {
  /** The ledger file, inside a git checkout whose `origin` is the ledger's remote. */
  readonly ledger: string
  /** The randomizer's secret seed: 32 or more bytes, readable only by its owner. */
  readonly seed: string
  /** The directory holding the sealed packs and their `manifest.json`. */
  readonly packs: string
}

export function readCanaryConfig(path: string): CanaryConfig {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new AppError(
      'CANARY_CONFIG_UNREADABLE',
      `Cannot read the canary configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const config = value as Partial<CanaryConfig>
  for (const key of ['ledger', 'seed', 'packs'] as const)
    if (typeof config[key] !== 'string' || config[key] === '')
      throw new AppError('CANARY_CONFIG_INVALID', `The canary configuration needs "${key}"`)
  return config as CanaryConfig
}

function readSeed(path: string): Buffer {
  const mode = statSync(path).mode & 0o077
  if (mode !== 0)
    throw new AppError('CANARY_SEED_EXPOSED', `The seed ${path} is readable by others`)
  const seed = readFileSync(path)
  if (seed.byteLength < 32)
    throw new AppError('CANARY_SEED_SHORT', 'The seed needs 32 or more bytes')
  return seed
}

/** The seed's commitment; revealing the seed at readout lets anyone recompute every arm. */
export function seedDigest(seed: Buffer): string {
  return `sha256:${createHmac('sha256', seed).update('braid-canary-seed-commitment').digest('hex')}`
}

/** One fair bit per task: the low bit of HMAC-SHA256(seed, experiment NUL task). */
export function armFor(seed: Buffer, experimentId: string, taskId: string): CanaryArm {
  const mac = createHmac('sha256', seed).update(`${experimentId}\u0000${taskId}`).digest()
  return ((mac[0] as number) & 1) === 1 ? 'candidate' : 'control'
}

/** Names the assignment in both arms without revealing which. */
export function assignmentIdFor(experimentId: string, taskId: string): string {
  return `ba-${canaryDigest(`${experimentId}\u0000${taskId}`).slice('sha256:'.length, 'sha256:'.length + 16)}`
}

function readManifest(directory: string): PackManifest {
  const path = join(directory, 'manifest.json')
  if (!existsSync(path)) throw new AppError('CANARY_PACKS_MISSING', `No pack manifest at ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as PackManifest
}

function packText(directory: string, file: string, digest: string): string {
  const text = readFileSync(join(directory, file), 'utf8')
  if (canaryDigest(text) !== digest)
    throw new AppError(
      'CANARY_PACK_CHANGED',
      `The pack ${file} no longer matches its sealed digest`,
    )
  return text
}

export interface SealResult {
  readonly experimentId: string
  readonly protocolDigest: string
  readonly entryDigest: string
  readonly skills: readonly string[]
}

/** Seal the protocol as the ledger's first entry. Refuses a ledger that already holds one. */
export async function sealCanary(
  config: CanaryConfig,
  input: CanaryProtocolInput,
  now: () => Date = () => new Date(),
): Promise<SealResult> {
  const { sealRandomizedCanaryRule } = await import('@tangle-network/agent-eval/experiment')
  const seed = readSeed(config.seed)
  const manifest = readManifest(config.packs)
  const skills = Object.keys(manifest.skills).sort()
  if (skills.length === 0)
    throw new AppError('CANARY_PACKS_EMPTY', 'The pack manifest names no skill')
  const packs: Record<string, string> = {}
  for (const skill of skills) {
    const pack = manifest.skills[skill] as { file: string; digest: string }
    packText(config.packs, pack.file, pack.digest)
    packs[skill] = pack.digest
  }
  if (!Number.isSafeInteger(input.eligibility.repositoryCap) || input.eligibility.repositoryCap < 1)
    throw new AppError('CANARY_PROTOCOL_INVALID', 'repositoryCap must be a positive integer')
  const eligibility = {
    unit: input.eligibility.unit,
    skills: packs,
    repositoryCap: input.eligibility.repositoryCap,
    acceptsUntil: input.analysis.analysisCutoff,
  }
  const randomizer = {
    method: 'hmac-sha256-low-bit',
    input: 'experimentId NUL taskId',
    candidateShare: 0.5,
    seedDigest: seedDigest(seed),
  }
  const sealed = sealRandomizedCanaryRule({
    ...input.analysis,
    experimentId: input.experimentId,
    eligibilityRuleDigest: canaryDigest(canonicalJson({ eligibility, randomizer })),
    controlProfileDigest: canaryDigest(canonicalJson({ packs: {} })),
    candidateProfileDigest: canaryDigest(canonicalJson({ packs })),
    servedCodeRevisionDigest: `git:${input.served.braidCommit}`,
    outcomeCheckerDigest: input.outcome.checkerDigest,
    assignmentUnit: 'task',
    clusterUnit: 'repository',
  })
  const protocol = {
    schema: PROTOCOL_SCHEMA,
    question: input.question,
    eligibility,
    randomizer,
    arms: {
      control: 'the brief as written, with the assignment line',
      candidate: "the brief followed by the skill's sealed pack, with the assignment line",
    },
    assignmentLine: `${ASSIGNMENT_LINE_PREFIX} <assignmentId>`,
    served: input.served,
    outcome: input.outcome,
    ...(input.secondary === undefined ? {} : { secondary: input.secondary }),
    ...(input.power === undefined ? {} : { power: input.power }),
    readoutAt: input.readoutAt,
    rule: sealed.rule,
  }
  appendLedger(
    config.ledger,
    (entries) => {
      if (entries.length > 0)
        throw new AppError('CANARY_ALREADY_SEALED', 'The ledger already holds a sealed protocol')
      return {
        append: {
          kind: 'protocol',
          experimentId: input.experimentId,
          protocolDigest: sealed.digest,
          protocol,
        },
        result: null,
      }
    },
    now,
  )
  const first = readLedger(config.ledger)[0] as ProtocolEntry
  return {
    experimentId: input.experimentId,
    protocolDigest: sealed.digest,
    entryDigest: first.digest,
    skills,
  }
}

interface Eligibility {
  readonly skills: Readonly<Record<string, string>>
  readonly repositoryCap: number
  readonly acceptsUntil: string
}

export interface AssignResult {
  readonly status: 'assigned' | 'existing' | 'ineligible'
  readonly experimentId: string
  readonly assignmentId: string | null
  readonly arm: CanaryArm | null
  readonly skill: string
  readonly repository: string
  readonly packDigest: string | null
  /** The pack text, in the candidate arm only. */
  readonly pack: string | null
  /** The line every pull request of the task repeats; null when ineligible. */
  readonly assignmentLine: string | null
  /** What to append to the brief: the pack in the candidate arm, then the assignment instruction. */
  readonly append: string | null
  readonly reason: string | null
}

function protocolOf(entries: readonly LedgerEntry[]): ProtocolEntry {
  const first = entries[0]
  if (first === undefined || first.kind !== 'protocol')
    throw new AppError(
      'CANARY_NOT_SEALED',
      'The ledger holds no sealed protocol; nothing is assigned before the seal',
    )
  return first
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

function instruction(line: string): string {
  return `Put this exact line in the body of every pull request this task opens:\n${line}`
}

/** Assign one task, or return the assignment it already holds. Every arrival is recorded. */
export function assignTask(
  config: CanaryConfig,
  request: { readonly taskId: string; readonly skill: string; readonly repository: string },
  now: () => Date = () => new Date(),
): AssignResult {
  const taskId = request.taskId.trim()
  if (taskId === '' || taskId.length > 200)
    throw new AppError('CANARY_TASK_INVALID', 'A task id is 1 to 200 characters')
  if (!REPOSITORY.test(request.repository))
    throw new AppError('CANARY_REPOSITORY_INVALID', 'The repository is owner/name')
  const seed = readSeed(config.seed)
  return appendLedger(
    config.ledger,
    (entries) => {
      const sealed = protocolOf(entries)
      const experimentId = sealed.experimentId
      const eligibility = sealed.protocol.eligibility as Eligibility
      const held = entries.find(
        (entry): entry is AssignmentEntry => entry.kind === 'assignment' && entry.taskId === taskId,
      )
      const result = (
        status: AssignResult['status'],
        entry: Pick<
          AssignmentEntry,
          'assignmentId' | 'arm' | 'skill' | 'packDigest' | 'repository'
        >,
      ): AssignResult => {
        const manifest = readManifest(config.packs)
        const file = manifest.skills[entry.skill]?.file
        const pack =
          entry.arm === 'candidate'
            ? packText(config.packs, file ?? `${entry.skill}.md`, entry.packDigest)
            : null
        const line = `${ASSIGNMENT_LINE_PREFIX} ${entry.assignmentId}`
        return {
          status,
          experimentId,
          assignmentId: entry.assignmentId,
          arm: entry.arm,
          skill: entry.skill,
          repository: entry.repository,
          packDigest: entry.packDigest,
          pack,
          assignmentLine: line,
          append: pack === null ? instruction(line) : `${pack.trimEnd()}\n\n${instruction(line)}`,
          reason: null,
        }
      }
      if (held !== undefined) return { append: null, result: result('existing', held) }
      const turnedAway = (reason: string) => ({
        append: {
          kind: 'disposition' as const,
          experimentId,
          taskId,
          skill: request.skill,
          repository: request.repository,
          reason,
        },
        result: {
          status: 'ineligible' as const,
          experimentId,
          assignmentId: null,
          arm: null,
          skill: request.skill,
          repository: request.repository,
          packDigest: null,
          pack: null,
          assignmentLine: null,
          append: null,
          reason,
        },
      })
      if (now().getTime() >= Date.parse(eligibility.acceptsUntil))
        return turnedAway(`the cutoff ${eligibility.acceptsUntil} has passed`)
      const packDigest = eligibility.skills[request.skill]
      if (packDigest === undefined)
        return turnedAway(`no sealed pack for the skill ${request.skill}`)
      const inRepository = entries.filter(
        (entry) => entry.kind === 'assignment' && entry.repository === request.repository,
      ).length
      if (inRepository >= eligibility.repositoryCap)
        return turnedAway(
          `${request.repository} already holds ${inRepository} assignments, the cap`,
        )
      const assignment = {
        kind: 'assignment' as const,
        experimentId,
        assignmentId: assignmentIdFor(experimentId, taskId),
        taskId,
        skill: request.skill,
        repository: request.repository,
        arm: armFor(seed, experimentId, taskId),
        packDigest,
      }
      return { append: assignment, result: result('assigned', assignment) }
    },
    now,
  )
}

export interface CanaryStatus {
  readonly experimentId: string
  readonly protocolDigest: string
  readonly sealedAt: string
  readonly acceptsUntil: string
  readonly readoutAt: string
  readonly entries: number
  readonly tipDigest: string
  readonly assignments: { readonly control: number; readonly candidate: number }
  readonly repositories: number
  readonly dispositions: number
}

export function canaryStatus(config: CanaryConfig): CanaryStatus {
  syncLedger(config.ledger)
  const entries = readLedger(config.ledger)
  const sealed = protocolOf(entries)
  const assignments = entries.filter(
    (entry): entry is AssignmentEntry => entry.kind === 'assignment',
  )
  return {
    experimentId: sealed.experimentId,
    protocolDigest: sealed.protocolDigest,
    sealedAt: sealed.at,
    acceptsUntil: (sealed.protocol.eligibility as Eligibility).acceptsUntil,
    readoutAt: String(sealed.protocol.readoutAt),
    entries: entries.length,
    tipDigest: (entries.at(-1) as LedgerEntry).digest,
    assignments: {
      control: assignments.filter((entry) => entry.arm === 'control').length,
      candidate: assignments.filter((entry) => entry.arm === 'candidate').length,
    },
    repositories: new Set(assignments.map((entry) => entry.repository)).size,
    dispositions: entries.filter((entry) => entry.kind === 'disposition').length,
  }
}
