import { randomUUID } from 'node:crypto'

import { collectCredentialSecrets, redactText } from '../release/redaction.mjs'

export const EXIT_CODES = Object.freeze({
  passed: 0,
  failed: 1,
  unavailable: 2,
})

export const PUBLIC_EVIDENCE_SCHEMA = 'braid.live-required.evidence.v1'

export const PROOF_OPERATIONS = Object.freeze({
  tangleInference: 'tangle.inference.turn',
  tangleSandbox: 'tangle.sandbox.turn',
  traceAnalysis: 'trace.analysis.ask-promote',
  supervisor: 'supervisor.snapshot-reconnect-steer',
})

const PROOF_OPERATION_CHECKS = Object.freeze({
  [PROOF_OPERATIONS.tangleInference]: Object.freeze([
    'normal-turn',
    'cancelled-turn',
    'materialization-receipt',
  ]),
  [PROOF_OPERATIONS.tangleSandbox]: Object.freeze(['marker', 'environment-id']),
  [PROOF_OPERATIONS.traceAnalysis]: Object.freeze([
    'source-frozen',
    'cited-finding',
    'persisted',
    'promoted',
  ]),
  [PROOF_OPERATIONS.supervisor]: Object.freeze(['snapshot', 'reconnect', 'steering']),
})

const PROOF_OPERATION_FACT_KEYS = Object.freeze({
  [PROOF_OPERATIONS.tangleInference]: Object.freeze(['normalRunId', 'cancelledRunId']),
  [PROOF_OPERATIONS.tangleSandbox]: Object.freeze(['environmentId']),
  [PROOF_OPERATIONS.traceAnalysis]: Object.freeze(['analysisId', 'findingCount', 'promoted']),
  [PROOF_OPERATIONS.supervisor]: Object.freeze([
    'supervisorId',
    'workerId',
    'steeringRequestId',
    'cancellationAvailable',
  ]),
})

const PROOF_STATUSES = new Set(['passed', 'partial', 'unavailable'])
const PROOF_EVIDENCE_KEYS = Object.freeze([
  'schema',
  'invocationId',
  'operation',
  'status',
  'startedAt',
  'completedAt',
  'connection',
  'run',
  'facts',
  'checks',
])
const PROOF_CONNECTION_KEYS = Object.freeze([
  'endpoint',
  'connectionId',
  'connectionKind',
  'credentialConfigured',
  'model',
  'runner',
])
const PROOF_RUN_KEYS = Object.freeze(['ids', 'environmentId', 'materializationDigest'])
const CREDENTIAL_KEY_PATTERN =
  /(?:^|_)(?:access_key|api_key|auth|authorization|bearer|client_secret|cookie|credential|password|passwd|private_key|secret|session|token)(?:_|$)/u
const MAX_PUBLIC_DEPTH = 8

const REQUIRED_RELEASE_MEASUREMENTS = Object.freeze({
  'live-tangle': Object.freeze(['LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10']),
  'live-analysis': Object.freeze(['LIVE-12']),
  'live-supervisor': Object.freeze(['LIVE-11']),
})

export class LiveRequiredError extends Error {
  constructor(code, message, { unavailable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LiveRequiredError'
    this.code = code
    this.unavailable = unavailable
  }
}

export function protectedUnavailable(code, message, cause) {
  return new LiveRequiredError(code, message, { unavailable: true, cause })
}

function redactionSecrets(environment) {
  return collectCredentialSecrets(environment)
}

function normalizedKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[-\s]+/gu, '_')
    .toLowerCase()
}

function credentialKey(value) {
  const key = normalizedKey(value)
  return key !== 'credential_configured' && CREDENTIAL_KEY_PATTERN.test(key)
}

function credentialLeafSecrets(value, secrets, seen) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    if (typeof value === 'string' || typeof value === 'number') secrets.push(String(value))
    return
  }
  if (seen.has(value)) return
  seen.add(value)
  let keys
  try {
    keys = Object.getOwnPropertyNames(value)
  } catch {
    return
  }
  for (const key of keys) {
    try {
      credentialLeafSecrets(value[key], secrets, seen)
    } catch {}
  }
}

function credentialFieldSecrets(value, secrets = [], seen = new Set()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return secrets
  if (seen.has(value)) return secrets
  seen.add(value)
  let keys
  try {
    keys = Object.getOwnPropertyNames(value)
  } catch {
    return secrets
  }
  for (const key of keys) {
    let nested
    try {
      nested = value[key]
    } catch {
      continue
    }
    if (credentialKey(key)) credentialLeafSecrets(nested, secrets, seen)
    credentialFieldSecrets(nested, secrets, seen)
  }
  return secrets
}

function redactionSecretsFor(value, environment) {
  return [
    ...new Set(
      [...redactionSecrets(environment), ...credentialFieldSecrets(value)].filter(
        (candidate) => String(candidate).length > 0,
      ),
    ),
  ]
}

function safeText(value, environment, extraSecrets = []) {
  let text
  try {
    text = String(value)
  } catch {
    text = '[UNAVAILABLE]'
  }
  const secrets = [...new Set([...redactionSecrets(environment), ...extraSecrets])]
  return [...redactText(text, secrets)]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
    })
    .join('')
}

function sanitizePublicValue(value, environment, secrets, seen = new Set(), depth = 0) {
  if (depth > MAX_PUBLIC_DEPTH) return '[TRUNCATED]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return safeText(value, environment, secrets)
  if (typeof value === 'undefined') return undefined
  if (typeof value === 'bigint') return String(value)
  if (value instanceof Error) {
    return {
      name: safeText(value.name, environment, secrets).slice(0, 128),
      message: safeText(value.message, environment, secrets).slice(0, 1_024),
    }
  }
  if (typeof value !== 'object') return '[UNAVAILABLE]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value))
    return value.map((entry) => sanitizePublicValue(entry, environment, secrets, seen, depth + 1))
  const output = {}
  let keys
  try {
    keys = Object.keys(value)
  } catch {
    return '[UNAVAILABLE]'
  }
  for (const key of keys) {
    if (credentialKey(key)) {
      output[key] = '[REDACTED]'
      continue
    }
    let nested
    try {
      nested = value[key]
    } catch {
      output[key] = '[UNAVAILABLE]'
      continue
    }
    const sanitized = sanitizePublicValue(nested, environment, secrets, seen, depth + 1)
    if (sanitized !== undefined) output[key] = sanitized
  }
  return output
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index]))
    throw new Error(`${label} contains fields outside the public schema`)
}

function validNullableString(value, label) {
  if (value !== null && (typeof value !== 'string' || value.length === 0))
    throw new Error(`${label} must be a non-empty string or null`)
}

function validTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new Error(`${label} must be an ISO timestamp`)
}

function validateProofFacts(operation, facts) {
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts))
    throw new Error('Live proof facts must be an object')
  exactKeys(facts, PROOF_OPERATION_FACT_KEYS[operation], 'Live proof facts')
  for (const [key, value] of Object.entries(facts)) {
    if (key === 'findingCount') {
      if (value !== null && (!Number.isInteger(value) || value < 0))
        throw new Error('Live proof findingCount must be a non-negative integer or null')
      continue
    }
    if (key === 'promoted' || key === 'cancellationAvailable') {
      if (typeof value !== 'boolean') throw new Error(`Live proof ${key} must be boolean`)
      continue
    }
    validNullableString(value, `Live proof ${key}`)
  }
}

export function proofInvocation(scope) {
  if (typeof scope !== 'string' || scope.trim().length === 0)
    throw new Error('Live proof scope must be a non-empty string')
  return `live-required-${scope}-${randomUUID()}`
}

export function assertProofReceipt(receipt, { invocationId, operation } = {}) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt))
    throw new Error('Live proof receipt must be an object')
  exactKeys(receipt, PROOF_EVIDENCE_KEYS, 'Live proof receipt')
  if (receipt.schema !== PUBLIC_EVIDENCE_SCHEMA)
    throw new Error('Live proof receipt has an unsupported schema')
  if (typeof receipt.invocationId !== 'string' || receipt.invocationId.length === 0)
    throw new Error('Live proof receipt has no invocation binding')
  if (invocationId !== undefined && receipt.invocationId !== invocationId)
    throw new Error('Live proof receipt belongs to a different invocation')
  if (typeof receipt.operation !== 'string' || !PROOF_OPERATION_CHECKS[receipt.operation])
    throw new Error('Live proof receipt has an unsupported operation')
  if (operation !== undefined && receipt.operation !== operation)
    throw new Error('Live proof receipt belongs to a different operation')
  if (!PROOF_STATUSES.has(receipt.status))
    throw new Error('Live proof receipt has an invalid status')
  validTimestamp(receipt.startedAt, 'Live proof startedAt')
  validTimestamp(receipt.completedAt, 'Live proof completedAt')
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt))
    throw new Error('Live proof receipt completed before it started')
  exactKeys(receipt.connection, PROOF_CONNECTION_KEYS, 'Live proof connection')
  validNullableString(receipt.connection.endpoint, 'Live proof endpoint')
  validNullableString(receipt.connection.connectionId, 'Live proof connectionId')
  validNullableString(receipt.connection.connectionKind, 'Live proof connectionKind')
  if (
    receipt.connection.credentialConfigured !== null &&
    typeof receipt.connection.credentialConfigured !== 'boolean'
  )
    throw new Error('Live proof credentialConfigured must be boolean or null')
  validNullableString(receipt.connection.model, 'Live proof model')
  validNullableString(receipt.connection.runner, 'Live proof runner')
  exactKeys(receipt.run, PROOF_RUN_KEYS, 'Live proof run')
  if (
    !Array.isArray(receipt.run.ids) ||
    receipt.run.ids.length > 8 ||
    receipt.run.ids.some((id) => typeof id !== 'string' || id.length === 0)
  )
    throw new Error('Live proof run ids are invalid')
  validNullableString(receipt.run.environmentId, 'Live proof environmentId')
  validNullableString(receipt.run.materializationDigest, 'Live proof materializationDigest')
  validateProofFacts(receipt.operation, receipt.facts)
  if (
    !Array.isArray(receipt.checks) ||
    receipt.checks.length === 0 ||
    new Set(receipt.checks).size !== receipt.checks.length ||
    receipt.checks.some(
      (check) =>
        typeof check !== 'string' || !PROOF_OPERATION_CHECKS[receipt.operation].includes(check),
    )
  )
    throw new Error('Live proof checks are not part of the named operation')
  return receipt
}

export function proofReceipt({
  invocationId,
  operation,
  status = 'passed',
  startedAt,
  completedAt,
  config,
  runIds = [],
  environmentId = null,
  materializationDigest = null,
  facts = {},
  checks = [],
}) {
  const receipt = {
    schema: PUBLIC_EVIDENCE_SCHEMA,
    invocationId,
    operation,
    status,
    startedAt: startedAt ?? new Date().toISOString(),
    completedAt: completedAt ?? new Date().toISOString(),
    connection: {
      endpoint: config?.endpoint ?? null,
      connectionId: config?.connectionId ?? null,
      connectionKind: config?.connectionKind ?? null,
      credentialConfigured:
        typeof config?.credentialConfigured === 'boolean' ? config.credentialConfigured : null,
      model: config?.model ?? null,
      runner: config?.runner ?? null,
    },
    run: {
      ids: [...runIds],
      environmentId,
      materializationDigest,
    },
    facts,
    checks: [...checks],
  }
  assertProofReceipt(receipt, { invocationId, operation })
  return Object.freeze({
    ...receipt,
    connection: Object.freeze(receipt.connection),
    run: Object.freeze({ ...receipt.run, ids: Object.freeze(receipt.run.ids) }),
    facts: Object.freeze({ ...receipt.facts }),
    checks: Object.freeze(receipt.checks),
  })
}

export function safeMessage(error, environment = process.env) {
  const value = error instanceof Error ? error.message : error
  return safeText(value, environment, credentialFieldSecrets(error)).slice(0, 1_024)
}

export function safeJson(value, environment = process.env) {
  const secrets = redactionSecretsFor(value, environment)
  const sanitized = sanitizePublicValue(value, environment, secrets)
  let serialized
  try {
    serialized = JSON.stringify(sanitized)
  } catch {
    serialized = JSON.stringify({ status: 'unavailable', reason: '[UNAVAILABLE]' })
  }
  return redactText(serialized === undefined ? 'null' : serialized, secrets)
}

export function endpointEvidence(value) {
  try {
    const endpoint = new URL(value)
    return `${endpoint.protocol}//${endpoint.host}${endpoint.pathname.replace(/\/$/u, '')}`
  } catch {
    return '<invalid-endpoint>'
  }
}

export function scalarMeasurement(name, value = 1) {
  return { kind: 'scalar', name, unit: 'verified-flow', value }
}

export function requiredEnvironment(environment, entries, label) {
  const missing = entries.filter(({ name }) => {
    const value = environment[name]
    return typeof value !== 'string' || value.trim().length === 0
  })
  if (missing.length > 0) {
    throw protectedUnavailable(
      'PROTECTED_CONFIGURATION_REQUIRED',
      `${label} requires ${missing.map(({ name, description }) => `${name} (${description})`).join(', ')}`,
    )
  }
}

export function normalizeExternalFailure(error, label, environment = process.env) {
  const message = safeMessage(error, environment)
  if (error instanceof LiveRequiredError) {
    if (error.message === message) return error
    return new LiveRequiredError(error.code, message, { unavailable: error.unavailable })
  }
  return new LiveRequiredError(
    'LIVE_REAL_PATH_FAILED',
    `${label} failed against the configured live path: ${message}`,
    { cause: error },
  )
}

export function classifyExternalFailure(error, label, environment = process.env) {
  const classified = normalizeExternalFailure(error, label, environment)
  if (classified.unavailable) return classified
  throw classified
}

export function releaseOutcome(scope, result) {
  const required = REQUIRED_RELEASE_MEASUREMENTS[scope] ?? []
  const measured = new Set(
    Array.isArray(result.measurements)
      ? result.measurements
          .map((measurement) => measurement?.name)
          .filter((name) => typeof name === 'string')
      : [],
  )
  const complete = required.length > 0 && required.every((name) => measured.has(name))
  if (result.status === 'passed' && complete) {
    return { status: 'passed', exitCode: EXIT_CODES.passed }
  }
  if (result.status === 'failed') {
    return { status: 'failed', exitCode: EXIT_CODES.failed }
  }
  return {
    status: 'unavailable',
    exitCode: EXIT_CODES.unavailable,
    reason: `${scope} did not prove all required live measurements: ${required.join(', ')}`,
  }
}

export function resultSummary(scope, result) {
  const summary = {
    scope,
    status: result.status,
    ...(result.flows === undefined ? {} : { flows: result.flows }),
    ...(result.measurements === undefined ? {} : { measurements: result.measurements }),
    ...(result.unavailable === undefined ? {} : { unavailable: result.unavailable }),
  }
  if (result.evidence !== undefined) {
    try {
      summary.evidence = assertProofReceipt(result.evidence)
    } catch {}
  }
  return summary
}
