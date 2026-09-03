import { randomUUID } from 'node:crypto'
import {
  liveEvidenceBindingFromEnvironment,
  parseLiveEvidenceBinding,
} from '../release/live-evidence-binding.mjs'
import { collectCredentialSecrets, redactText } from '../release/redaction.mjs'
import { assertMultirunProof } from './multirun-contract.mjs'

export const EXIT_CODES = Object.freeze({
  passed: 0,
  failed: 1,
  unavailable: 2,
})

export const PUBLIC_EVIDENCE_SCHEMA = 'braid.live-required.evidence.v1'
export const TANGLE_RECEIPTS_SCHEMA = 'braid.live-required.tangle-receipts.v1'

export const PROOF_OPERATIONS = Object.freeze({
  tangleInference: 'tangle.inference.turn',
  tangleSandbox: 'tangle.sandbox.turn',
  tangleSandboxInteractive: 'tangle.sandbox.interactive',
  tangleWorkspaceFork: 'tangle.sandbox.workspace-fork',
  tangleConfidential: 'tangle.sandbox.confidential',
  traceAnalysis: 'trace.analysis.ask-promote',
  supervisor: 'supervisor.snapshot-reconnect-steer',
})

const PROOF_OPERATION_CHECKS = Object.freeze({
  [PROOF_OPERATIONS.tangleInference]: Object.freeze([
    'normal-turn',
    'cancelled-turn',
    'cancellation-reported-unavailable',
    'materialization-receipt',
  ]),
  [PROOF_OPERATIONS.tangleSandbox]: Object.freeze([
    'marker',
    'environment-id',
    'workspace-read-write-exec-git',
    'sigkill-reconnect',
    'exclusive-replay',
    'follow-up-session',
    'cancel-retry-conflict',
    'exact-resource-cleanup',
  ]),
  [PROOF_OPERATIONS.tangleSandboxInteractive]: Object.freeze([
    'packed-binary',
    'interactive-command',
    'input',
    'detach',
    'reconnect',
    'terminal-resize',
    'same-local-run',
    'same-provider-control-ref',
    'sandbox-observed-before-stop',
    'stop-through-braid',
    'sandbox-observed-stopped',
    'exact-resource-cleanup',
    'process-exited-before-cleanup',
    'process-group-exited-before-cleanup',
    'provider-bound-input',
    'provider-bound-reconnect',
    'single-provider-execution',
    'exact-owned-resource-set-cleanup',
    'account-identity-stable',
    'active-resource-delta',
    'telemetry-complete',
    'spend-disclosed',
    'latency-observed',
  ]),
  [PROOF_OPERATIONS.tangleWorkspaceFork]: Object.freeze([
    'configuration',
    'source-run',
    'plan',
    'execute',
    'retry',
    'restart',
    'independent-destination',
    'source-unchanged',
    'cleanup-checkpoint',
    'cleanup-environment',
  ]),
  [PROOF_OPERATIONS.tangleConfidential]: Object.freeze([
    'configuration',
    'capability',
    'nitro-attestation',
    'requested-unverified-binding',
    'missing-attestation',
    'valid-attestation',
    'wrong-nonce',
    'wrong-measurement',
    'self-echo',
    'confidential-refusal',
    'no-ordinary-downgrade',
    'no-child-or-checkpoint',
    'resource-census',
    'cleanup',
  ]),
  [PROOF_OPERATIONS.traceAnalysis]: Object.freeze([
    'source-frozen',
    'cited-finding',
    'restart-restored',
    'promoted',
  ]),
  [PROOF_OPERATIONS.supervisor]: Object.freeze([
    'snapshot',
    'spend-status',
    'steering',
    'steering-acknowledged',
    'cancellation',
    'reconnect',
    'terminal-takeover',
  ]),
})

const PROOF_OPERATION_CHECK_VARIANTS = Object.freeze({
  [PROOF_OPERATIONS.tangleInference]: Object.freeze([
    Object.freeze(['normal-turn', 'cancelled-turn', 'materialization-receipt']),
    Object.freeze(['normal-turn', 'cancellation-reported-unavailable', 'materialization-receipt']),
  ]),
  [PROOF_OPERATIONS.tangleConfidential]: Object.freeze([
    Object.freeze([
      'configuration',
      'capability',
      'nitro-attestation',
      'requested-unverified-binding',
      'missing-attestation',
      'valid-attestation',
      'wrong-nonce',
      'wrong-measurement',
      'self-echo',
      'resource-census',
      'cleanup',
    ]),
    Object.freeze([
      'configuration',
      'capability',
      'confidential-refusal',
      'no-ordinary-downgrade',
      'no-child-or-checkpoint',
      'resource-census',
      'cleanup',
    ]),
  ]),
})

const PROOF_OPERATION_FACT_KEYS = Object.freeze({
  [PROOF_OPERATIONS.tangleInference]: Object.freeze([
    'normalRunId',
    'cancelledRunId',
    'cancellationStatus',
    'cancellationResponseCode',
  ]),
  [PROOF_OPERATIONS.tangleSandbox]: Object.freeze([
    'environmentId',
    'resumedRunId',
    'followUpRunId',
    'cancelledRunId',
    'resumeFromCursor',
    'finalCursor',
    'cloudControl',
    'exactResource',
    'activeResourceDelta',
  ]),
  [PROOF_OPERATIONS.tangleSandboxInteractive]: Object.freeze([
    'environmentId',
    'localRunId',
    'stoppedStatus',
    'cloudControl',
    'exactResource',
    'processExitedBeforeWorkspaceCleanup',
    'terminalResize',
    'processGroupExitedBeforeWorkspaceCleanup',
    'providerInput',
    'providerReconnect',
    'singleProviderExecution',
    'exactOwnedResourceSetCleanup',
    'accountIdentityStable',
    'activeResourceDelta',
    'telemetryComplete',
    'spendDisclosed',
    'latencyObserved',
  ]),
  [PROOF_OPERATIONS.tangleWorkspaceFork]: Object.freeze([
    'sourceProviderEnvironmentId',
    'destinationProviderEnvironmentId',
    'checkpointRetried',
    'forkRetried',
    'restarted',
    'sourceDigestBefore',
    'sourceDigestAfter',
    'destinationDigest',
    'cleanupCheckpoint',
    'cleanupEnvironment',
  ]),
  [PROOF_OPERATIONS.tangleConfidential]: Object.freeze([
    'sourceProviderEnvironmentId',
    'destinationProviderEnvironmentId',
    'capabilityAdvertised',
    'capabilityConsistent',
    'confidentialRequested',
    'confidentialVerified',
    'confidentialActionRefused',
    'noOrdinaryPlacementDowngrade',
    'noChildOrCheckpointCreated',
    'missingAttestationRejected',
    'wrongNonceRejected',
    'wrongMeasurementRejected',
    'selfEchoRejected',
    'activeResourceDelta',
    'cleanupCheckpoint',
    'cleanupEnvironment',
  ]),
  [PROOF_OPERATIONS.traceAnalysis]: Object.freeze([
    'analysisId',
    'findingCount',
    'modelCallCount',
    'promoted',
    'usage',
  ]),
  [PROOF_OPERATIONS.supervisor]: Object.freeze([
    'supervisorId',
    'workerId',
    'steeringRequestId',
    'steeringOperationId',
    'steeringEffect',
    'cancellationOperationId',
    'cancellationEffect',
    'initialStatus',
    'finalStatus',
    'spendObserved',
    'statusObserved',
    'reconnectable',
    'terminalTakeover',
    'terminalTakeoverRequired',
    'cancellationAvailable',
    'provisioned',
    'cleanupVerified',
  ]),
})

const PROOF_STATUSES = new Set(['passed', 'partial', 'failed', 'unavailable'])
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
  'observations',
])
const PROOF_EVIDENCE_OPTIONAL_KEYS = Object.freeze(['releaseBinding'])
const PROOF_CONNECTION_KEYS = Object.freeze([
  'endpoint',
  'connectionId',
  'connectionKind',
  'credentialConfigured',
  'model',
  'modelProvider',
  'runner',
])
const PROOF_RUN_KEYS = Object.freeze(['ids', 'environmentId', 'materializationDigest'])
const CLOUD_CONTROL_KEYS = Object.freeze([
  'provider',
  'environmentId',
  'sessionId',
  'executionId',
  'runId',
  'requestDigest',
])
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

function exactKeys(value, expected, label, optional = []) {
  const actual = Object.keys(value).sort()
  const allowed = new Set([...expected, ...optional])
  if (actual.some((key) => !allowed.has(key)))
    throw new Error(`${label} contains fields outside the public schema`)
  if (expected.some((key) => !actual.includes(key)))
    throw new Error(`${label} contains fields outside the public schema`)
}

function validNullableString(value, label) {
  if (value !== null && (typeof value !== 'string' || value.length === 0))
    throw new Error(`${label} must be a non-empty string or null`)
}

function validRequiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} must be a non-empty string`)
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateCloudControl(value) {
  if (value === null) return
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Live proof cloudControl must be an object or null')
  exactKeys(value, CLOUD_CONTROL_KEYS, 'Live proof cloudControl')
  for (const key of CLOUD_CONTROL_KEYS) validNullableString(value[key], `Live proof ${key}`)
}

function validateObservations(value) {
  if (value !== null && (typeof value !== 'object' || Array.isArray(value)))
    throw new Error('Live proof observations must be an object or null')
  if (value === null) return

  const seen = new Set()
  const visit = (candidate, path) => {
    if (candidate === null || typeof candidate !== 'object') return
    if (seen.has(candidate)) return
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => {
        visit(entry, `${path}[${index}]`)
      })
      return
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (credentialKey(key) && nested !== '[REDACTED]')
        throw new Error(`Live proof observations.${key} must be redacted`)
      visit(nested, `${path}.${key}`)
    }
  }
  visit(value, 'observations')
}

function validTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new Error(`${label} must be an ISO timestamp`)
}

function validateProofFacts(operation, status, facts) {
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts))
    throw new Error('Live proof facts must be an object')
  exactKeys(facts, PROOF_OPERATION_FACT_KEYS[operation], 'Live proof facts')
  for (const [key, value] of Object.entries(facts)) {
    if (key === 'findingCount' || key === 'modelCallCount') {
      if (value !== null && (!Number.isInteger(value) || value < 0))
        throw new Error(`Live proof ${key} must be a non-negative integer or null`)
      continue
    }
    if (key === 'usage') {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Live proof usage must be an object')
      exactKeys(
        value,
        ['inputTokens', 'outputTokens', 'tokensKnown', 'costKind', 'costUsd', 'usdKnown'],
        'Live proof usage',
      )
      for (const tokenField of ['inputTokens', 'outputTokens']) {
        if (!Number.isSafeInteger(value[tokenField]) || value[tokenField] < 0)
          throw new Error(`Live proof usage ${tokenField} must be a non-negative safe integer`)
      }
      if (typeof value.tokensKnown !== 'boolean' || typeof value.usdKnown !== 'boolean')
        throw new Error('Live proof usage knowledge fields must be boolean')
      if (!['observed', 'estimated'].includes(value.costKind))
        throw new Error('Live proof usage costKind must be observed or estimated')
      if (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0)
        throw new Error('Live proof usage costUsd must be a non-negative finite number')
      continue
    }
    if (
      key === 'missingAttestationRejected' ||
      key === 'wrongNonceRejected' ||
      key === 'wrongMeasurementRejected' ||
      key === 'selfEchoRejected'
    ) {
      if (value !== null && typeof value !== 'boolean')
        throw new Error(`Live proof ${key} must be boolean or null`)
      continue
    }
    if (
      key === 'promoted' ||
      key === 'cancellationAvailable' ||
      key === 'terminalTakeoverRequired' ||
      key === 'spendObserved' ||
      key === 'statusObserved' ||
      key === 'reconnectable' ||
      key === 'provisioned' ||
      key === 'cleanupVerified' ||
      key === 'checkpointRetried' ||
      key === 'forkRetried' ||
      key === 'restarted' ||
      key === 'capabilityAdvertised' ||
      key === 'capabilityConsistent' ||
      key === 'confidentialRequested' ||
      key === 'confidentialVerified' ||
      key === 'confidentialActionRefused' ||
      key === 'noOrdinaryPlacementDowngrade' ||
      key === 'noChildOrCheckpointCreated' ||
      key === 'processExitedBeforeWorkspaceCleanup' ||
      key === 'terminalResize' ||
      key === 'processGroupExitedBeforeWorkspaceCleanup' ||
      key === 'providerInput' ||
      key === 'providerReconnect' ||
      key === 'singleProviderExecution' ||
      key === 'exactOwnedResourceSetCleanup' ||
      key === 'accountIdentityStable' ||
      key === 'telemetryComplete' ||
      key === 'spendDisclosed' ||
      key === 'latencyObserved'
    ) {
      if (typeof value !== 'boolean') throw new Error(`Live proof ${key} must be boolean`)
      continue
    }
    if (key === 'exactResource') {
      if (value !== null && typeof value !== 'boolean')
        throw new Error('Live proof exactResource must be boolean or null')
      continue
    }
    if (key === 'activeResourceDelta') {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
        throw new Error('Live proof activeResourceDelta must be a finite number or null')
      continue
    }
    if (key === 'cloudControl') {
      validateCloudControl(value)
      continue
    }
    if (key === 'cancellationStatus') {
      if (value !== null && !['confirmed', 'reported-unavailable'].includes(value))
        throw new Error(
          'Live proof cancellationStatus must be confirmed, reported-unavailable, or null',
        )
      continue
    }
    if (key === 'cancellationResponseCode') {
      if (value !== null && !['CAPABILITY_UNAVAILABLE', 'UNKNOWN_RUN'].includes(value))
        throw new Error(
          'Live proof cancellationResponseCode must be CAPABILITY_UNAVAILABLE, UNKNOWN_RUN, or null',
        )
      continue
    }
    validNullableString(value, `Live proof ${key}`)
  }
  if (operation === PROOF_OPERATIONS.traceAnalysis && status === 'passed') {
    if (!Number.isInteger(facts.findingCount) || facts.findingCount < 1)
      throw new Error('Passed trace-analysis proof requires at least one cited finding')
    if (!Number.isInteger(facts.modelCallCount) || facts.modelCallCount < 1)
      throw new Error('Passed trace-analysis proof requires at least one model-call record')
    if (facts.promoted !== true)
      throw new Error('Passed trace-analysis proof requires successful promotion')
    if (facts.usage.tokensKnown !== true)
      throw new Error('Passed trace-analysis proof requires known token usage')
  }
}

function validatePassedTangleInferenceReceipt(receipt) {
  const { facts, run } = receipt
  const checks = new Set(receipt.checks)
  validRequiredString(facts.normalRunId, 'Passed Tangle inference facts.normalRunId')
  if (facts.cancellationStatus === 'confirmed') {
    if (!checks.has('cancelled-turn') || checks.has('cancellation-reported-unavailable'))
      throw new Error('Confirmed Tangle inference proof requires the cancelled-turn check')
    if (facts.cancellationResponseCode !== null)
      throw new Error('Confirmed Tangle inference cancellation must have no response code')
    validRequiredString(facts.cancelledRunId, 'Passed Tangle inference facts.cancelledRunId')
    if (facts.cancelledRunId === facts.normalRunId)
      throw new Error('Confirmed Tangle inference cancellation must use a distinct run ID')
    if (run.ids.length !== 2)
      throw new Error('Confirmed Tangle inference proof requires normal and cancelled run IDs')
    if (!run.ids.includes(facts.normalRunId) || !run.ids.includes(facts.cancelledRunId))
      throw new Error('Confirmed Tangle inference proof is missing a referenced run ID')
    return
  }
  if (facts.cancellationStatus !== 'reported-unavailable')
    throw new Error(
      'Passed Tangle inference proof requires confirmed or reported-unavailable cancellation',
    )
  if (!checks.has('cancellation-reported-unavailable') || checks.has('cancelled-turn'))
    throw new Error(
      'Unavailable Tangle inference proof requires the cancellation-reported-unavailable check',
    )
  if (facts.cancelledRunId !== null)
    throw new Error('Unavailable Tangle inference cancellation cannot have a cancelled run ID')
  if (!['CAPABILITY_UNAVAILABLE', 'UNKNOWN_RUN'].includes(facts.cancellationResponseCode))
    throw new Error('Unavailable Tangle inference cancellation requires a recognized response code')
  if (run.ids.length !== 1 || run.ids[0] !== facts.normalRunId)
    throw new Error('Unavailable Tangle inference proof requires only the normal run ID')
}

function validatePassedSupervisorReceipt(receipt) {
  const { facts } = receipt
  for (const key of ['spendObserved', 'statusObserved', 'reconnectable', 'cancellationAvailable']) {
    if (facts[key] !== true) throw new Error(`Passed supervisor proof requires ${key} to be true`)
  }
  if (facts.initialStatus !== 'running')
    throw new Error('Passed supervisor proof requires a running worker at the first snapshot')
  if (!['cancelled', 'down'].includes(facts.finalStatus))
    throw new Error('Passed supervisor proof requires a terminal cancelled worker snapshot')
  if (facts.steeringEffect !== 'delivered')
    throw new Error('Passed supervisor proof requires a delivered steering effect')
  if (facts.cancellationEffect !== 'cancelled')
    throw new Error('Passed supervisor proof requires a cancelled worker effect')
  if (!['attached', 'unavailable'].includes(facts.terminalTakeover))
    throw new Error('Passed supervisor proof requires an attached or unavailable terminal takeover')
  if (facts.provisioned === true && facts.cleanupVerified !== true)
    throw new Error('Passed provisioned supervisor proof requires verified cleanup')
  if (facts.terminalTakeoverRequired === true && facts.terminalTakeover !== 'attached')
    throw new Error(
      'Passed supervisor proof requires terminal takeover when the provider supports it',
    )
  if (receipt.observations === null || typeof receipt.observations !== 'object')
    throw new Error('Passed supervisor proof requires provisioning and cleanup observations')
  const provisioning = receipt.observations.provisioning
  const cleanup = receipt.observations.cleanup
  if (provisioning === undefined || cleanup === undefined)
    throw new Error('Passed supervisor proof requires provisioning and cleanup observations')
  if (typeof provisioning !== 'object' || Array.isArray(provisioning))
    throw new Error('Passed supervisor provisioning observation must be an object')
  if (typeof cleanup !== 'object' || Array.isArray(cleanup))
    throw new Error('Passed supervisor cleanup observation must be an object')
  const provisioningKeys = ['mode', 'rootDir', 'supervisorId', 'workerId', 'terminalTakeover']
  exactKeys(provisioning, provisioningKeys, 'Passed supervisor provisioning observation')
  if (!['configured', 'provisioned'].includes(provisioning.mode))
    throw new Error('Passed supervisor provisioning mode is invalid')
  for (const key of ['rootDir', 'supervisorId', 'workerId'])
    validRequiredString(provisioning[key], `Passed supervisor provisioning ${key}`)
  if (!['required', 'unsupported', 'unspecified'].includes(provisioning.terminalTakeover))
    throw new Error('Passed supervisor provisioning terminal takeover requirement is invalid')
  const cleanupKeys = [
    'status',
    'rootDir',
    'supervisorId',
    'workerId',
    'supervisorStatus',
    'workerStatus',
    'resourcesReleased',
    'remainingResources',
  ]
  exactKeys(cleanup, cleanupKeys, 'Passed supervisor cleanup observation')
  if (!['completed', 'not-owned'].includes(cleanup.status))
    throw new Error('Passed supervisor cleanup status is invalid')
  for (const key of ['rootDir', 'supervisorId', 'workerId'])
    validRequiredString(cleanup[key], `Passed supervisor cleanup ${key}`)
  if (cleanup.supervisorStatus !== null && typeof cleanup.supervisorStatus !== 'string')
    throw new Error('Passed supervisor cleanup supervisorStatus must be a string or null')
  if (cleanup.workerStatus !== null && typeof cleanup.workerStatus !== 'string')
    throw new Error('Passed supervisor cleanup workerStatus must be a string or null')
  if (cleanup.resourcesReleased !== null && typeof cleanup.resourcesReleased !== 'boolean')
    throw new Error('Passed supervisor cleanup resourcesReleased must be boolean or null')
  if (cleanup.remainingResources !== null && !Array.isArray(cleanup.remainingResources))
    throw new Error('Passed supervisor cleanup remainingResources must be an array or null')
  if (facts.provisioned === true) {
    if (provisioning.mode !== 'provisioned')
      throw new Error('Passed provisioned supervisor proof has a configured provisioning mode')
    if (cleanup.status !== 'completed' || cleanup.resourcesReleased !== true)
      throw new Error('Passed provisioned supervisor proof requires completed resource cleanup')
    if (!Array.isArray(cleanup.remainingResources) || cleanup.remainingResources.length !== 0)
      throw new Error('Passed provisioned supervisor proof left resources behind')
  } else if (provisioning.mode !== 'configured' || cleanup.status !== 'not-owned') {
    throw new Error('Passed configured supervisor proof has an invalid ownership receipt')
  }
}

function validatePassedTangleSandboxReceipt(receipt) {
  if (receipt.run.ids.length === 0)
    throw new Error('Passed Tangle Sandbox proof requires at least one local run ID')
  if (new Set(receipt.run.ids).size !== receipt.run.ids.length)
    throw new Error('Passed Tangle Sandbox proof requires unique local run IDs')
  validRequiredString(receipt.run.environmentId, 'Passed Tangle Sandbox local environmentId')

  const requiredConnectionFields = ['endpoint', 'connectionId', 'connectionKind', 'model', 'runner']
  for (const field of requiredConnectionFields)
    validRequiredString(receipt.connection[field], `Passed Tangle Sandbox connection.${field}`)
  if (receipt.connection.connectionKind !== 'tangle-sandbox')
    throw new Error('Passed Tangle Sandbox proof requires a tangle-sandbox connection')
  if (receipt.connection.credentialConfigured !== true)
    throw new Error('Passed Tangle Sandbox proof requires configured credentials')

  const cloudControl = receipt.facts.cloudControl
  if (cloudControl === null) {
    throw new Error('Passed Tangle Sandbox proof requires exact cloud control identity')
  }
  for (const field of CLOUD_CONTROL_KEYS)
    validRequiredString(cloudControl[field], `Passed Tangle Sandbox cloudControl.${field}`)
  if (cloudControl.provider !== 'tangle-sandbox')
    throw new Error('Passed Tangle Sandbox cloud control identity has the wrong provider')
  if (!/^sha256:[0-9a-f]{64}$/u.test(cloudControl.requestDigest))
    throw new Error('Passed Tangle Sandbox cloud control requestDigest is not a SHA-256 digest')

  for (const field of ['resumedRunId', 'followUpRunId', 'cancelledRunId'])
    validRequiredString(receipt.facts[field], `Passed Tangle Sandbox facts.${field}`)
  if (receipt.facts.environmentId !== receipt.run.environmentId)
    throw new Error('Passed Tangle Sandbox local environment identity is inconsistent')
  for (const field of ['resumedRunId', 'followUpRunId', 'cancelledRunId']) {
    if (!receipt.run.ids.includes(receipt.facts[field]))
      throw new Error(`Passed Tangle Sandbox ${field} is missing from local run IDs`)
  }
  for (const field of ['resumeFromCursor', 'finalCursor'])
    validRequiredString(receipt.facts[field], `Passed Tangle Sandbox facts.${field}`)
  if (receipt.facts.exactResource !== true)
    throw new Error('Passed Tangle Sandbox proof requires cleanup exactResource=true')
  if (receipt.facts.activeResourceDelta !== 0)
    throw new Error('Passed Tangle Sandbox proof requires numeric activeResourceDelta=0')
  if (receipt.observations === null || Object.keys(receipt.observations).length === 0)
    throw new Error('Passed Tangle Sandbox proof requires redacted observations')
  assertMultirunProof(receipt.observations.multirun)
}

function validatePassedTangleSandboxInteractiveReceipt(receipt) {
  if (receipt.run.ids.length !== 1)
    throw new Error('Passed Tangle interactive proof requires one local run ID')
  validRequiredString(receipt.run.environmentId, 'Passed Tangle interactive local environmentId')

  const requiredConnectionFields = ['endpoint', 'connectionId', 'connectionKind', 'model', 'runner']
  for (const field of requiredConnectionFields)
    validRequiredString(receipt.connection[field], `Passed Tangle interactive connection.${field}`)
  if (receipt.connection.connectionKind !== 'tangle-sandbox')
    throw new Error('Passed Tangle interactive proof requires a tangle-sandbox connection')
  if (receipt.connection.runner !== 'pi')
    throw new Error('Passed Tangle interactive proof requires the native Pi harness')
  if (receipt.connection.credentialConfigured !== true)
    throw new Error('Passed Tangle interactive proof requires configured credentials')

  if (receipt.facts.localRunId !== receipt.run.ids[0])
    throw new Error('Passed Tangle interactive local run identity is inconsistent')
  if (receipt.facts.environmentId !== receipt.run.environmentId)
    throw new Error('Passed Tangle interactive environment identity is inconsistent')
  if (!['aborted', 'cancelled'].includes(receipt.facts.stoppedStatus))
    throw new Error('Passed Tangle interactive proof requires a terminal stopped status')
  const cloudControl = receipt.facts.cloudControl
  if (cloudControl === null)
    throw new Error('Passed Tangle interactive proof requires exact cloud control identity')
  for (const field of CLOUD_CONTROL_KEYS)
    validRequiredString(cloudControl[field], `Passed Tangle interactive cloudControl.${field}`)
  if (cloudControl.provider !== 'tangle-sandbox')
    throw new Error('Passed Tangle interactive cloud control identity has the wrong provider')
  if (!/^sha256:[0-9a-f]{64}$/u.test(cloudControl.requestDigest))
    throw new Error('Passed Tangle interactive cloud control requestDigest is not a SHA-256 digest')
  if (receipt.facts.exactResource !== true)
    throw new Error('Passed Tangle interactive proof requires exact resource cleanup')
  if (receipt.facts.processExitedBeforeWorkspaceCleanup !== true)
    throw new Error('Passed Tangle interactive proof requires process exit before cleanup')
  if (receipt.facts.terminalResize !== true)
    throw new Error('Passed Tangle interactive proof requires terminal resize evidence')
  if (receipt.facts.processGroupExitedBeforeWorkspaceCleanup !== true)
    throw new Error('Passed Tangle interactive proof requires process-group exit before cleanup')
  for (const field of [
    'providerInput',
    'providerReconnect',
    'singleProviderExecution',
    'exactOwnedResourceSetCleanup',
    'accountIdentityStable',
    'telemetryComplete',
    'spendDisclosed',
    'latencyObserved',
  ]) {
    if (receipt.facts[field] !== true)
      throw new Error(`Passed Tangle interactive proof requires ${field}=true`)
  }
  if (receipt.facts.activeResourceDelta !== 0)
    throw new Error('Passed Tangle interactive proof requires activeResourceDelta=0')
  if (!record(receipt.observations) || Object.keys(receipt.observations).length === 0)
    throw new Error('Passed Tangle interactive proof requires redacted observations')
  for (const field of [
    'checks',
    'configuration',
    'run',
    'sandbox',
    'identityContinuity',
    'processCleanup',
    'providerEvidence',
    'providerExecution',
    'usage',
    'accountIdentities',
    'accountIdentityConsistency',
    'usageDelta',
    'telemetry',
    'spend',
    'timing',
  ]) {
    if (!record(receipt.observations[field]))
      throw new Error(`Passed Tangle interactive proof requires observations.${field}`)
  }
}

function validatePassedTangleWorkspaceForkReceipt(receipt) {
  const requiredConnectionFields = ['endpoint', 'connectionId', 'connectionKind', 'model', 'runner']
  for (const field of requiredConnectionFields)
    validRequiredString(
      receipt.connection[field],
      `Passed Tangle workspace-fork connection.${field}`,
    )
  if (receipt.connection.connectionKind !== 'tangle-sandbox')
    throw new Error('Passed Tangle workspace-fork proof requires a tangle-sandbox connection')
  if (receipt.connection.credentialConfigured !== true)
    throw new Error('Passed Tangle workspace-fork proof requires configured credentials')
  if (receipt.run.ids.length !== 1)
    throw new Error('Passed Tangle workspace-fork proof requires one source run ID')
  validRequiredString(receipt.run.environmentId, 'Passed Tangle workspace-fork environmentId')
  for (const field of [
    'sourceProviderEnvironmentId',
    'destinationProviderEnvironmentId',
    'sourceDigestBefore',
    'sourceDigestAfter',
    'destinationDigest',
  ])
    validRequiredString(receipt.facts[field], `Passed Tangle workspace-fork ${field}`)
  if (receipt.facts.sourceProviderEnvironmentId === receipt.facts.destinationProviderEnvironmentId)
    throw new Error('Passed Tangle workspace-fork proof reused its source environment')
  if (receipt.facts.sourceDigestBefore !== receipt.facts.sourceDigestAfter)
    throw new Error('Passed Tangle workspace-fork proof changed the source workspace')
  for (const field of ['checkpointRetried', 'forkRetried', 'restarted']) {
    if (receipt.facts[field] !== true)
      throw new Error(`Passed Tangle workspace-fork proof requires ${field}=true`)
  }
  for (const field of ['cleanupCheckpoint', 'cleanupEnvironment']) {
    if (!['deleted', 'already_absent'].includes(receipt.facts[field]))
      throw new Error(`Passed Tangle workspace-fork proof requires ${field} cleanup`)
  }
  if (receipt.observations === null || Object.keys(receipt.observations).length === 0)
    throw new Error('Passed Tangle workspace-fork proof requires redacted observations')
}

function validateConfidentialResourceCensus(value, expectedActiveResourceDelta) {
  if (!record(value)) throw new Error('Passed Tangle confidential proof requires a resource census')
  for (const phase of ['before', 'after']) {
    const census = value[phase]
    if (!record(census))
      throw new Error(`Passed Tangle confidential proof has no ${phase} resource census`)
    if (!Number.isSafeInteger(census.count) || census.count < 0)
      throw new Error(`Passed Tangle confidential ${phase} census has an invalid count`)
    if (
      !Array.isArray(census.ids) ||
      census.ids.length !== census.count ||
      census.ids.some((id) => typeof id !== 'string' || id.length === 0) ||
      new Set(census.ids).size !== census.ids.length
    )
      throw new Error(`Passed Tangle confidential ${phase} census has invalid resource ids`)
    if (!Array.isArray(census.resources) || census.resources.length !== census.count)
      throw new Error(`Passed Tangle confidential ${phase} census has no resource records`)
    const resourceIds = census.resources.map((resource) => {
      if (!record(resource) || typeof resource.id !== 'string' || resource.id.length === 0)
        throw new Error(`Passed Tangle confidential ${phase} census has an invalid resource record`)
      if (resource.status !== null && typeof resource.status !== 'string')
        throw new Error(`Passed Tangle confidential ${phase} census has an invalid resource status`)
      return resource.id
    })
    if (JSON.stringify(resourceIds) !== JSON.stringify(census.ids))
      throw new Error(`Passed Tangle confidential ${phase} census ids do not match its records`)
  }
  const activeResourceDelta = value.after.count - value.before.count
  const unchanged =
    activeResourceDelta === 0 &&
    JSON.stringify(value.before.ids) === JSON.stringify(value.after.ids)
  if (value.activeResourceDelta !== activeResourceDelta || value.unchanged !== unchanged)
    throw new Error('Passed Tangle confidential resource census does not match its derived result')
  if (expectedActiveResourceDelta !== activeResourceDelta)
    throw new Error('Passed Tangle confidential census delta does not match its fact')
  if (unchanged !== true)
    throw new Error('Passed Tangle confidential proof requires an unchanged resource census')
}

function validatePassedTangleConfidentialReceipt(receipt) {
  const requiredConnectionFields = ['endpoint', 'connectionId', 'connectionKind', 'model', 'runner']
  for (const field of requiredConnectionFields)
    validRequiredString(receipt.connection[field], `Passed Tangle confidential connection.${field}`)
  if (receipt.connection.connectionKind !== 'tangle-sandbox')
    throw new Error('Passed Tangle confidential proof requires a tangle-sandbox connection')
  if (receipt.connection.credentialConfigured !== true)
    throw new Error('Passed Tangle confidential proof requires configured credentials')
  if (receipt.run.ids.length !== 1)
    throw new Error('Passed Tangle confidential proof requires one source run ID')
  validRequiredString(receipt.run.environmentId, 'Passed Tangle confidential environmentId')
  if (typeof receipt.facts.capabilityAdvertised !== 'boolean')
    throw new Error('Passed Tangle confidential proof requires an advertised capability fact')
  if (receipt.facts.capabilityConsistent !== true)
    throw new Error(
      'Passed Tangle confidential proof requires provider and source capability agreement',
    )
  if (receipt.facts.confidentialRequested !== true)
    throw new Error('Passed Tangle confidential proof requires a requested confidential fork')
  validRequiredString(
    receipt.facts.sourceProviderEnvironmentId,
    'Passed Tangle confidential sourceProviderEnvironmentId',
  )
  if (receipt.facts.capabilityAdvertised === true) {
    if (receipt.facts.confidentialVerified !== true)
      throw new Error(
        'Passed Tangle confidential proof requires an externally verified attestation',
      )
    if (receipt.facts.confidentialActionRefused !== false)
      throw new Error('Attested Tangle confidential proof cannot report action refusal')
    if (receipt.facts.noOrdinaryPlacementDowngrade !== true)
      throw new Error('Attested Tangle confidential proof requires no ordinary-placement downgrade')
    if (receipt.facts.noChildOrCheckpointCreated !== false)
      throw new Error('Attested Tangle confidential proof requires its child and checkpoint')
    if (
      receipt.facts.missingAttestationRejected !== true ||
      receipt.facts.wrongNonceRejected !== true ||
      receipt.facts.wrongMeasurementRejected !== true ||
      receipt.facts.selfEchoRejected !== true
    )
      throw new Error('Passed Tangle confidential proof requires all negative checks')
    validRequiredString(
      receipt.facts.destinationProviderEnvironmentId,
      'Passed Tangle confidential destinationProviderEnvironmentId',
    )
    if (
      receipt.facts.sourceProviderEnvironmentId === receipt.facts.destinationProviderEnvironmentId
    )
      throw new Error('Passed Tangle confidential proof reused its source environment')
    for (const field of ['cleanupCheckpoint', 'cleanupEnvironment']) {
      if (!['deleted', 'already_absent'].includes(receipt.facts[field]))
        throw new Error(`Passed Tangle confidential proof requires ${field} cleanup`)
    }
  } else {
    if (receipt.facts.confidentialVerified !== false)
      throw new Error('Refused Tangle confidential proof cannot claim an attestation')
    if (receipt.facts.confidentialActionRefused !== true)
      throw new Error('Refused Tangle confidential proof requires action refusal')
    if (receipt.facts.noOrdinaryPlacementDowngrade !== true)
      throw new Error('Refused Tangle confidential proof requires no ordinary-placement downgrade')
    if (receipt.facts.noChildOrCheckpointCreated !== true)
      throw new Error('Refused Tangle confidential proof requires no child or checkpoint')
    if (receipt.facts.destinationProviderEnvironmentId !== null)
      throw new Error('Refused Tangle confidential proof cannot have a destination environment')
    if (
      receipt.facts.missingAttestationRejected !== null ||
      receipt.facts.wrongNonceRejected !== null ||
      receipt.facts.wrongMeasurementRejected !== null ||
      receipt.facts.selfEchoRejected !== null
    )
      throw new Error('Refused Tangle confidential proof cannot claim attestation negative checks')
    if (receipt.facts.cleanupCheckpoint !== null || receipt.facts.cleanupEnvironment !== null)
      throw new Error('Refused Tangle confidential proof cannot claim fork cleanup')
  }
  if (receipt.facts.activeResourceDelta !== 0)
    throw new Error('Passed Tangle confidential proof requires activeResourceDelta=0')
  if (receipt.observations === null || Object.keys(receipt.observations).length === 0)
    throw new Error('Passed Tangle confidential proof requires redacted observations')
  const capability = receipt.observations.capability
  if (!record(capability))
    throw new Error('Passed Tangle confidential proof requires capability observations')
  if (
    capability.providerBranchingConfidential !== receipt.facts.capabilityAdvertised ||
    capability.sourceBranchingConfidential !== receipt.facts.capabilityAdvertised ||
    capability.consistent !== true
  )
    throw new Error('Passed Tangle confidential capability observations are inconsistent')
  validateConfidentialResourceCensus(
    receipt.observations.resourceCensus,
    receipt.facts.activeResourceDelta,
  )
  if (receipt.facts.capabilityAdvertised === true) {
    const attestation = receipt.observations.attestation
    if (
      !record(attestation) ||
      attestation.providerKeyAuthenticated !== true ||
      attestation.signatureDistinctFromQuote !== true ||
      attestation.requestedUnverifiedBeforeExecution !== true ||
      attestation.wrongNonceRejected !== true ||
      attestation.wrongMeasurementRejected !== true ||
      attestation.selfEchoRejected !== true
    )
      throw new Error('Passed Tangle confidential proof requires attestation observations')
  } else {
    const refusal = receipt.observations.refusal
    if (!record(refusal) || refusal.executeErrorCode !== 'CAPABILITY_UNAVAILABLE')
      throw new Error('Refused Tangle confidential proof requires execution refusal evidence')
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
  exactKeys(receipt, PROOF_EVIDENCE_KEYS, 'Live proof receipt', PROOF_EVIDENCE_OPTIONAL_KEYS)
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
  if (receipt.operation === PROOF_OPERATIONS.supervisor && receipt.status === 'partial')
    throw new Error('LIVE-11 supervisor proof cannot have a partial status')
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
  validNullableString(receipt.connection.modelProvider, 'Live proof modelProvider')
  validNullableString(receipt.connection.runner, 'Live proof runner')
  validateObservations(receipt.observations)
  if (receipt.releaseBinding !== undefined)
    parseLiveEvidenceBinding(receipt.releaseBinding, 'Live proof release binding')
  exactKeys(receipt.run, PROOF_RUN_KEYS, 'Live proof run')
  if (
    !Array.isArray(receipt.run.ids) ||
    receipt.run.ids.length > 8 ||
    receipt.run.ids.some((id) => typeof id !== 'string' || id.length === 0)
  )
    throw new Error('Live proof run ids are invalid')
  validNullableString(receipt.run.environmentId, 'Live proof environmentId')
  validNullableString(receipt.run.materializationDigest, 'Live proof materializationDigest')
  validateProofFacts(receipt.operation, receipt.status, receipt.facts)
  const requiredChecks = PROOF_OPERATION_CHECKS[receipt.operation]
  const checkVariants = PROOF_OPERATION_CHECK_VARIANTS[receipt.operation] ?? [requiredChecks]
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
  if (receipt.status === 'passed') {
    const matchesVariant = checkVariants.some(
      (variant) =>
        receipt.checks.length === variant.length &&
        variant.every((check) => receipt.checks.includes(check)),
    )
    if (!matchesVariant)
      throw new Error('Passed live proof must include every check from one complete variant')
  }
  if (receipt.operation === PROOF_OPERATIONS.tangleInference && receipt.status === 'passed')
    validatePassedTangleInferenceReceipt(receipt)
  if (receipt.operation === PROOF_OPERATIONS.tangleSandbox && receipt.status === 'passed')
    validatePassedTangleSandboxReceipt(receipt)
  if (
    receipt.operation === PROOF_OPERATIONS.tangleSandboxInteractive &&
    receipt.status === 'passed'
  )
    validatePassedTangleSandboxInteractiveReceipt(receipt)
  if (receipt.operation === PROOF_OPERATIONS.tangleWorkspaceFork && receipt.status === 'passed')
    validatePassedTangleWorkspaceForkReceipt(receipt)
  if (receipt.operation === PROOF_OPERATIONS.tangleConfidential && receipt.status === 'passed')
    validatePassedTangleConfidentialReceipt(receipt)
  if (receipt.operation === PROOF_OPERATIONS.supervisor && receipt.status === 'passed')
    validatePassedSupervisorReceipt(receipt)
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
  observations = null,
  environment = process.env,
}) {
  const publicObservations =
    observations === null
      ? null
      : sanitizePublicValue(
          observations,
          environment,
          redactionSecretsFor(observations, environment),
        )
  const releaseBinding = liveEvidenceBindingFromEnvironment(environment)
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
      modelProvider: config?.modelProvider ?? null,
      runner: config?.runner ?? null,
    },
    run: {
      ids: [...runIds],
      environmentId,
      materializationDigest,
    },
    facts,
    checks: [...checks],
    observations: publicObservations,
    ...(releaseBinding === undefined ? {} : { releaseBinding }),
  }
  assertProofReceipt(receipt, { invocationId, operation })
  return Object.freeze({
    ...receipt,
    connection: Object.freeze(receipt.connection),
    run: Object.freeze({ ...receipt.run, ids: Object.freeze(receipt.run.ids) }),
    facts: Object.freeze({ ...receipt.facts }),
    checks: Object.freeze(receipt.checks),
    observations: receipt.observations === null ? null : Object.freeze({ ...receipt.observations }),
  })
}

export function safeMessage(error, environment = process.env) {
  const value = error instanceof Error ? error.message : error
  return safeText(value, environment, credentialFieldSecrets(error)).slice(0, 1_024)
}

const MAX_EXTERNAL_FAILURE_MESSAGES = 8
const MAX_EXTERNAL_FAILURE_MESSAGE_LENGTH = 4_096

function externalFailureMessages(error, environment, messages = [], seen = new Set()) {
  if (
    error === null ||
    (typeof error !== 'object' && typeof error !== 'function') ||
    seen.has(error) ||
    messages.length >= MAX_EXTERNAL_FAILURE_MESSAGES
  )
    return messages
  seen.add(error)
  const message = safeMessage(error, environment)
  if (message.length > 0 && !messages.includes(message)) messages.push(message)
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      externalFailureMessages(nested, environment, messages, seen)
      if (messages.length >= MAX_EXTERNAL_FAILURE_MESSAGES) break
    }
  }
  externalFailureMessages(error.cause, environment, messages, seen)
  return messages
}

function externalFailureMessage(error, environment) {
  const messages = externalFailureMessages(error, environment)
  return messages.join('; ').slice(0, MAX_EXTERNAL_FAILURE_MESSAGE_LENGTH)
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
  return serialized === undefined ? 'null' : serialized
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

export function tangleReceiptsArtifact(flows) {
  if (!Array.isArray(flows)) throw new Error('Tangle receipt flows must be an array')
  return {
    schema: TANGLE_RECEIPTS_SCHEMA,
    flows: flows.map((flow) => ({
      row: flow.row,
      status: flow.status,
      ...(flow.reason === undefined ? {} : { reason: flow.reason }),
      ...(flow.evidence === undefined ? {} : { evidence: flow.evidence }),
    })),
  }
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
  const message =
    error instanceof LiveRequiredError
      ? safeMessage(error, environment)
      : externalFailureMessage(error, environment)
  if (error instanceof LiveRequiredError) {
    if (error.message === message) return error
    return new LiveRequiredError(error.code, message, { unavailable: error.unavailable })
  }
  if (error?.unavailable === true) {
    return new LiveRequiredError('LIVE_PROTECTED_PATH_UNAVAILABLE', message, { unavailable: true })
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
