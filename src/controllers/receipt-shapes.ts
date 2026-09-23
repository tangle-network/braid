import {
  agentProfileSchema,
  canonicalAgentProfileDigest,
  harnessTypeSchema,
  reasoningLadder,
  type AgentProfile,
} from '@tangle-network/agent-interface'
import { containsControlCharacters } from '../connection/redaction.js'
import { profileSchemaIdentity } from '../profile/profile-schema-identity.js'
import {
  normalizeRunIdentifiers,
  normalizeRunOverrides,
} from './admission-input.js'

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const SOURCE_KINDS = new Set([
  'inline',
  'local-file',
  'stdin',
  'configured',
  'provider-catalog',
  'github',
])
const CONNECTION_KINDS = new Set(['cli-bridge', 'tangle-inference', 'tangle-sandbox'])
const WORKSPACE_CAPABILITIES = new Set([
  'project-config',
  'profile-source',
  'hook',
  'local-mcp',
  'resource-write',
  'environment-reference',
])
const SELECTION_SOURCES = new Set([
  'next-run',
  'branch',
  'workspace',
  'user',
  'profile',
  'canonical',
  'none',
])
const SELECTION_FIDELITIES = new Set(['exact', 'snapped', 'ignored', 'unsupported', 'unset'])

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const known = new Set(allowed)
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new Error(`${field} contains an unsupported field`)
  }
}

function text(value: unknown, field: string, maxLength = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    containsControlCharacters(value)
  ) {
    throw new Error(`${field} must be bounded, non-empty, and single-line text`)
  }
  return value
}

function optionalText(value: unknown, field: string, maxLength = 512): void {
  if (value !== undefined) text(value, field, maxLength)
}

export function assertReceiptDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${field} must be a sha256 digest`)
  }
}

export function assertReceiptTimestamp(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${field} must be a canonical ISO timestamp`)
  }
}

export function assertProfileSnapshot(
  value: unknown,
  expectedDigest: unknown,
  field: string,
): void {
  const parsed = agentProfileSchema.safeParse(value)
  if (!parsed.success) throw new Error(`${field} is not a canonical profile`)
  assertReceiptDigest(expectedDigest, `${field} digest`)
  if (canonicalAgentProfileDigest(parsed.data as AgentProfile) !== expectedDigest) {
    throw new Error(`${field} digest does not match its snapshot`)
  }
}

function assertIdentifiers(value: unknown, field: string): void {
  try {
    normalizeRunIdentifiers(value as never)
  } catch {
    throw new Error(`${field} has an invalid canonical shape`)
  }
}

function assertSource(value: unknown): void {
  const source = record(value, 'Receipt profile source')
  keys(source, ['kind', 'value', 'label', 'revision', 'writable'], 'Receipt profile source')
  if (typeof source.kind !== 'string' || !SOURCE_KINDS.has(source.kind)) {
    throw new Error('Receipt profile source has an unknown kind')
  }
  text(source.value, 'Receipt profile source value', 4_096)
  text(source.label, 'Receipt profile source label', 512)
  optionalText(source.revision, 'Receipt profile source revision', 512)
  if (typeof source.writable !== 'boolean') {
    throw new Error('Receipt profile source writable flag is invalid')
  }
}

function assertSchema(value: unknown): void {
  const schema = record(value, 'Receipt schema')
  keys(schema, ['package', 'version', 'digestAlgorithm', 'serialization'], 'Receipt schema')
  const expected = profileSchemaIdentity()
  if (
    schema.package !== expected.package ||
    schema.version !== expected.version ||
    schema.digestAlgorithm !== expected.digestAlgorithm ||
    schema.serialization !== expected.serialization
  ) {
    throw new Error('Receipt schema does not match the installed canonical profile package')
  }
}

function assertConnection(value: unknown): void {
  const connection = record(value, 'Receipt connection')
  keys(
    connection,
    ['id', 'kind', 'name', 'endpoint', 'account'],
    'Receipt connection',
  )
  text(connection.id, 'Receipt connection id', 128)
  if (typeof connection.kind !== 'string' || !CONNECTION_KINDS.has(connection.kind)) {
    throw new Error('Receipt connection kind is invalid')
  }
  text(connection.name, 'Receipt connection name', 256)
  optionalText(connection.endpoint, 'Receipt connection endpoint', 2_048)
  optionalText(connection.account, 'Receipt connection account', 256)
}

function assertRequested(value: unknown): void {
  try {
    const candidate = record(value, 'Receipt requested overrides')
    normalizeRunOverrides(candidate as never, 'Receipt requested overrides')
  } catch {
    throw new Error('Receipt requested overrides have an invalid canonical shape')
  }
}

function selectionValue(value: unknown, field: string, dimension: string): void {
  if (value === undefined) return
  if (dimension === 'runner') {
    if (typeof value !== 'string' || !harnessTypeSchema.safeParse(value).success) {
      throw new Error(`${field} is not a canonical runner`)
    }
    return
  }
  if (dimension === 'effort') {
    if (typeof value !== 'string' || !reasoningLadder.includes(value as never)) {
      throw new Error(`${field} is not a canonical reasoning effort`)
    }
    return
  }
  text(value, field, 512)
}

function assertSelectionDimension(value: unknown, field: string, dimension: string): void {
  const selection = record(value, field)
  keys(selection, ['requested', 'effective', 'source', 'fidelity', 'reason'], field)
  if (typeof selection.source !== 'string' || !SELECTION_SOURCES.has(selection.source)) {
    throw new Error(`${field}.source is invalid`)
  }
  if (typeof selection.fidelity !== 'string' || !SELECTION_FIDELITIES.has(selection.fidelity)) {
    throw new Error(`${field}.fidelity is invalid`)
  }
  selectionValue(selection.requested, `${field}.requested`, dimension)
  selectionValue(selection.effective, `${field}.effective`, dimension)
  optionalText(selection.reason, `${field}.reason`, 512)
  if (selection.fidelity === 'unset') {
    if (selection.source !== 'none' || selection.requested !== undefined || selection.effective !== undefined) {
      throw new Error(`${field} has an invalid unset binding`)
    }
  }
  if (
    (selection.fidelity === 'exact' || selection.fidelity === 'snapped') &&
    selection.effective === undefined
  ) {
    throw new Error(`${field} is missing its effective value`)
  }
  if (
    (selection.fidelity === 'ignored' || selection.fidelity === 'unsupported') &&
    selection.effective !== undefined
  ) {
    throw new Error(`${field} carries an effective value it cannot honor`)
  }
}

function assertSelection(value: unknown): string {
  const selection = record(value, 'Receipt selection')
  keys(selection, ['runner', 'model', 'effort', 'mode', 'profile'], 'Receipt selection')
  assertSelectionDimension(selection.runner, 'Receipt selection runner', 'runner')
  assertSelectionDimension(selection.model, 'Receipt selection model', 'model')
  assertSelectionDimension(selection.effort, 'Receipt selection effort', 'effort')
  assertSelectionDimension(selection.mode, 'Receipt selection mode', 'mode')
  const parsed = agentProfileSchema.safeParse(selection.profile)
  if (!parsed.success) throw new Error('Receipt selection profile is not canonical')
  return canonicalAgentProfileDigest(parsed.data as AgentProfile)
}

function assertValidation(value: unknown): {
  readonly normalizedProfileDigest?: string
  readonly normalizedProfileAccepted: boolean
} {
  const validation = record(value, 'Receipt validation')
  keys(
    validation,
    ['issues', 'acceptedWarningCodes', 'normalizedProfile', 'normalizedProfileDigest', 'normalizedProfileAccepted'],
    'Receipt validation',
  )
  if (!Array.isArray(validation.issues) || validation.issues.length > 256) {
    throw new Error('Receipt validation issues have an invalid bounded shape')
  }
  for (const issueValue of validation.issues) {
    const issue = record(issueValue, 'Receipt validation issue')
    keys(issue, ['level', 'code', 'message', 'path'], 'Receipt validation issue')
    if (issue.level !== 'error' && issue.level !== 'warning' && issue.level !== 'info') {
      throw new Error('Receipt validation issue has an invalid level')
    }
    text(issue.code, 'Receipt validation issue code', 128)
    text(issue.message, 'Receipt validation issue message', 512)
    optionalText(issue.path, 'Receipt validation issue path', 256)
  }
  if (!Array.isArray(validation.acceptedWarningCodes) || validation.acceptedWarningCodes.length > 256) {
    throw new Error('Receipt accepted warning codes have an invalid bounded shape')
  }
  const warningCodes = new Set<string>()
  for (const code of validation.acceptedWarningCodes) {
    const normalized = text(code, 'Receipt accepted warning code', 128)
    if (warningCodes.has(normalized)) throw new Error('Receipt accepted warning codes contain duplicates')
    warningCodes.add(normalized)
  }
  if (typeof validation.normalizedProfileAccepted !== 'boolean') {
    throw new Error('Receipt normalized-profile acceptance flag is invalid')
  }
  if (validation.normalizedProfile === undefined) {
    if (validation.normalizedProfileDigest !== undefined || validation.normalizedProfileAccepted) {
      throw new Error('Receipt accepts a normalized profile that is not present')
    }
    return { normalizedProfileAccepted: false }
  }
  assertProfileSnapshot(
    validation.normalizedProfile,
    validation.normalizedProfileDigest,
    'Receipt normalized profile',
  )
  return {
    normalizedProfileDigest: validation.normalizedProfileDigest as string,
    normalizedProfileAccepted: validation.normalizedProfileAccepted,
  }
}

function assertWorkspace(value: unknown): void {
  const workspace = record(value, 'Receipt workspace')
  keys(workspace, ['identity', 'trust', 'request'], 'Receipt workspace')
  optionalText(workspace.identity, 'Receipt workspace identity', 1_024)
  if (workspace.trust !== undefined) {
    const trust = record(workspace.trust, 'Receipt workspace trust')
    keys(trust, ['configurationDigest', 'approvedAt', 'capabilities'], 'Receipt workspace trust')
    assertReceiptDigest(trust.configurationDigest, 'Receipt workspace configuration digest')
    assertReceiptTimestamp(trust.approvedAt, 'Receipt workspace approvedAt')
    if (!Array.isArray(trust.capabilities) || trust.capabilities.length > WORKSPACE_CAPABILITIES.size) {
      throw new Error('Receipt workspace capabilities have an invalid bounded shape')
    }
    const seen = new Set<string>()
    for (const capability of trust.capabilities) {
      if (typeof capability !== 'string' || !WORKSPACE_CAPABILITIES.has(capability)) {
        throw new Error('Receipt workspace carries an unknown capability')
      }
      if (seen.has(capability)) throw new Error('Receipt workspace capabilities contain duplicates')
      seen.add(capability)
    }
  }
  if (workspace.request !== undefined) record(workspace.request, 'Receipt workspace request')
}

function assertEffectiveBinding(
  selection: unknown,
  validation: unknown,
  effectiveProfileDigest: unknown,
): void {
  const selectionDigest = assertSelection(selection)
  const validationResult = assertValidation(validation)
  assertReceiptDigest(effectiveProfileDigest, 'Receipt effective profile')
  const expected = validationResult.normalizedProfileAccepted
    ? validationResult.normalizedProfileDigest
    : selectionDigest
  if (expected !== effectiveProfileDigest) {
    throw new Error('Receipt effective profile does not match its selection and validation')
  }
}

export function assertPreAdmissionReceiptShape(value: Record<string, unknown>): void {
  assertIdentifiers(value.identifiers, 'Receipt identifiers')
  assertSource(value.source)
  if (value.sourceRevision !== undefined) {
    text(value.sourceRevision, 'Receipt source revision', 512)
    const source = record(value.source, 'Receipt profile source')
    if (source.revision !== value.sourceRevision) {
      throw new Error('Receipt source revision does not match its source')
    }
  }
  assertSchema(value.schema)
  assertConnection(value.connection)
  assertRequested(value.requested)
  assertEffectiveBinding(value.selection, value.validation, value.effectiveProfileDigest)
  assertWorkspace(value.workspace)
}

export function assertPostMaterializationReceiptShape(value: Record<string, unknown>): void {
  assertIdentifiers(value.identifiers, 'Receipt identifiers')
  assertSchema(value.schema)
  assertConnection(value.connection)
  assertRequested(value.requested)
  assertEffectiveBinding(value.selection, value.validation, value.effectiveProfileDigest)
  assertWorkspace(value.workspace)
}
