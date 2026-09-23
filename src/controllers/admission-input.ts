import {
  harnessTypeSchema,
  reasoningLadder,
  type AgentProfileSecurityPolicy,
} from '@tangle-network/agent-interface'
import { containsControlCharacters } from '../connection/redaction.js'
import { cloneBoundedProfileValue, type ProfileJsonLimits } from '../profile/profile-json.js'
import { boundedProfileSecurityPolicy } from '../profile/profile-validation.js'
import type { RunOverrides, SelectionLayers } from '../profile/run-selection.js'
import type { RunIdentifiers } from './admission-contracts.js'

const ADMISSION_INPUT_LIMITS: ProfileJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 16,
  maxNodes: 4_096,
  maxStringLength: 4_096,
  maxEntries: 4_096,
})

function cloneInput(value: unknown, field: string): unknown {
  try {
    return cloneBoundedProfileValue(value, ADMISSION_INPUT_LIMITS)
  } catch {
    throw new Error(`${field} is oversized or not JSON data`)
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${field}.${key} is not supported`)
  }
}

function boundedIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    containsControlCharacters(value)
  ) {
    throw new Error(`${field} must be bounded, non-empty, and single-line`)
  }
  return value
}

export function normalizeRunIdentifiers(value: RunIdentifiers): RunIdentifiers {
  const candidate = record(cloneInput(value, 'Admission identifiers'), 'Admission identifiers')
  assertKeys(
    candidate,
    ['operationId', 'turnId', 'branchId', 'conversationId'],
    'Admission identifiers',
  )
  return Object.freeze({
    operationId: boundedIdentifier(candidate.operationId, 'operationId'),
    turnId: boundedIdentifier(candidate.turnId, 'turnId'),
    branchId: boundedIdentifier(candidate.branchId, 'branchId'),
    conversationId: boundedIdentifier(candidate.conversationId, 'conversationId'),
  })
}

export function normalizeRunOverrides(
  value: RunOverrides | undefined,
  field = 'Run overrides',
): RunOverrides | undefined {
  if (value === undefined) return undefined
  const candidate = record(cloneInput(value, field), field)
  assertKeys(candidate, ['runner', 'model', 'effort', 'mode'], field)
  const normalized: Record<string, unknown> = {}
  if (candidate.runner !== undefined) {
    const runner = boundedIdentifier(candidate.runner, `${field}.runner`)
    const parsed = harnessTypeSchema.safeParse(runner)
    if (!parsed.success) throw new Error(`${field}.runner is not a canonical runner`)
    normalized.runner = parsed.data
  }
  if (candidate.model !== undefined) {
    normalized.model = boundedIdentifier(candidate.model, `${field}.model`)
  }
  if (candidate.effort !== undefined) {
    const effort = boundedIdentifier(candidate.effort, `${field}.effort`)
    if (!reasoningLadder.includes(effort as (typeof reasoningLadder)[number])) {
      throw new Error(`${field}.effort is not a canonical reasoning effort`)
    }
    normalized.effort = effort
  }
  if (candidate.mode !== undefined) {
    normalized.mode = boundedIdentifier(candidate.mode, `${field}.mode`)
  }
  return Object.freeze(normalized) as RunOverrides
}

export function normalizeSelectionLayers(value: SelectionLayers | undefined): SelectionLayers {
  if (value === undefined) return Object.freeze({})
  const candidate = record(cloneInput(value, 'Selection layers'), 'Selection layers')
  assertKeys(candidate, ['nextRun', 'branch', 'workspace', 'user'], 'Selection layers')
  const normalized: Record<string, unknown> = {}
  for (const key of ['nextRun', 'branch', 'workspace', 'user'] as const) {
    if (candidate[key] !== undefined) {
      normalized[key] = normalizeRunOverrides(candidate[key] as RunOverrides, `layers.${key}`)
    }
  }
  return Object.freeze(normalized) as SelectionLayers
}

export function normalizeWarningCodes(
  value: readonly string[] | undefined,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  const bounded = cloneInput(value, 'Accepted warning codes')
  if (!Array.isArray(bounded) || bounded.length > 256) {
    throw new Error('Accepted warning codes must be a bounded array')
  }
  const codes = bounded.map((code, index) =>
    boundedIdentifier(code, `acceptedWarningCodes.${index}`),
  )
  if (new Set(codes).size !== codes.length) {
    throw new Error('Accepted warning codes must not contain duplicates')
  }
  return Object.freeze(codes)
}

export function normalizeSecurityPolicy(
  value: AgentProfileSecurityPolicy | undefined,
): AgentProfileSecurityPolicy | undefined {
  return boundedProfileSecurityPolicy(value, ADMISSION_INPUT_LIMITS)
}

export function normalizeWorkspaceRequest(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined
  return record(cloneInput(value, 'Workspace request'), 'Workspace request')
}
