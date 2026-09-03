import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  workspaceCheckpointRequestDigest,
  workspaceCleanupRequestDigest,
  workspaceForkRequestDigest,
} from '@tangle-network/agent-interface'

import {
  assertProofReceipt,
  PROOF_OPERATIONS,
  proofReceipt,
} from '../scripts/live-required/contracts.mjs'
import {
  checkpointIdForOperation,
  cleanupWorkspaceProofResources,
  confidentialBranchingCapability,
  confidentialNegativeChecks,
  confidentialRefusalChecks,
  parseConfidentialTrustPolicy,
  resourceCensusComparison,
  sourceIdentityForRun,
} from '../scripts/live-required/tangle-workspace-proof.mjs'

const DIGEST = `sha256:${'1'.repeat(64)}`
const SECOND_DIGEST = `sha256:${'2'.repeat(64)}`
const AT = '2026-08-28T00:00:00.000Z'

function policyEnvironment(overrides = {}) {
  return {
    BRAID_TANGLE_CONFIDENTIAL_MEASUREMENTS: `${DIGEST},${SECOND_DIGEST}`,
    BRAID_TANGLE_CONFIDENTIAL_POLICY_IDS: 'tangle-confidential-v1,tangle-confidential-v2',
    BRAID_TANGLE_CONFIDENTIAL_POLICY_ID: 'tangle-confidential-v1',
    BRAID_TANGLE_CONFIDENTIAL_MAX_AGE_SECONDS: '300',
    ...overrides,
  }
}

function confidentialFixture() {
  const source = {
    runId: 'run-live-proof',
    provider: 'tangle-sandbox',
    environmentId: 'sandbox-source',
    sessionId: 'session-live-proof',
    executionId: 'execution-live-proof',
    requestDigest: DIGEST,
  }
  const checkpointMaterial = {
    source,
    name: 'checkpoint-live-proof',
    metadata: { proof: 'live-proof' },
  }
  const checkpoint = {
    checkpointId: 'snapshot-live-proof',
    provider: source.provider,
    source,
    idempotencyKey: 'operation-live-proof:checkpoint',
    requestDigest: workspaceCheckpointRequestDigest(checkpointMaterial),
    createdAt: '2026-08-28T00:00:00.000Z',
  }
  const requestMaterial = {
    checkpoint,
    name: 'fork-live-proof',
    metadata: { proof: 'live-proof' },
    placement: { kind: 'provider' },
    confidential: {
      requested: true,
      nonce: 'nonce-live-proof',
      policy: 'policy-live-proof',
      profileDigest: DIGEST,
    },
  }
  const request = {
    ...requestMaterial,
    idempotencyKey: 'operation-live-proof:fork',
    requestDigest: workspaceForkRequestDigest(requestMaterial),
  }
  const environment = {
    provider: source.provider,
    environmentId: 'sandbox-destination',
    sourceEnvironmentId: source.environmentId,
    source,
    sourceCheckpointId: checkpoint.checkpointId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    createdAt: '2026-08-28T00:00:01.000Z',
    placement: request.placement,
    confidentialRequested: true,
  }
  const attestation = {
    provider: source.provider,
    requested: true,
    nonce: request.confidential.nonce,
    measurement: DIGEST,
    environmentId: environment.environmentId,
    source,
    requestDigest: request.requestDigest,
    profileDigest: request.confidential.profileDigest,
    policy: request.confidential.policy,
    quote: 'raw-tee-quote',
    providerKeyId: 'provider-key-live-proof',
    providerSignature: 'provider-signature-live-proof',
    verifiedAt: '2026-08-28T00:00:02.000Z',
  }
  const verifyProviderAttestation = (candidate, expected) =>
    candidate.providerKeyId === 'provider-key-live-proof' &&
    candidate.providerSignature === 'provider-signature-live-proof' &&
    candidate.measurement === DIGEST &&
    candidate.environmentId === expected.environmentId
  return { request, environment, attestation, verifyProviderAttestation }
}

test('LIVE-10 negative checks reject nonce, measurement, and self-echo mutations', () => {
  const fixture = confidentialFixture()
  assert.deepEqual(confidentialNegativeChecks(fixture), {
    missingAttestationRejected: true,
    wrongNonceRejected: true,
    wrongMeasurementRejected: true,
    selfEchoRejected: true,
  })
})

test('LIVE-09 failure cleanup can recover partial source and checkpoint identities', () => {
  const run = {
    id: 'run-live-09-partial',
    operationId: 'op-live-09-source',
    environmentId: 'environment-local-source',
    status: 'running',
    complete: false,
    controlRef: {
      provider: 'tangle-sandbox',
      environmentId: 'sandbox-source-partial',
      sessionId: 'session-live-09-partial',
      executionId: 'execution-live-09-partial',
      runId: 'run-live-09-partial',
      requestDigest: DIGEST,
    },
  }
  const state = {
    runs: [run],
    environments: [
      {
        id: run.environmentId,
        providerEnvironmentId: run.controlRef.environmentId,
      },
    ],
    checkpoints: [{ id: 'checkpoint-live-09-partial', operationId: 'op-live-09-fork' }],
  }

  const recovered = sourceIdentityForRun(state, run.id)
  assert.equal(recovered?.run, run)
  assert.equal(recovered?.providerId, run.controlRef.environmentId)
  assert.equal(checkpointIdForOperation(state, 'op-live-09-fork'), 'checkpoint-live-09-partial')
  assert.equal(sourceIdentityForRun(state, 'missing-run'), undefined)
  assert.equal(
    sourceIdentityForRun(
      {
        ...state,
        environments: [{ ...state.environments[0], providerEnvironmentId: 'wrong-source' }],
      },
      run.id,
    ),
    undefined,
  )
})

test('LIVE-09 fault cleanup releases a partial checkpoint and source run', async () => {
  const sourceRun = {
    id: 'run-live-09-cleanup',
    environmentId: 'environment-local-source',
    status: 'running',
    complete: false,
  }
  let state = {
    runs: [sourceRun],
    checkpoints: [{ id: 'checkpoint-live-09-cleanup', operationId: 'op-live-09-fork' }],
  }
  const events = []
  const cleanupInputs = []
  let sourceExists = true
  const app = {
    state: () => state,
    cancelRun: async (input) => {
      events.push('source-cancel')
      assert.equal(input.runId, sourceRun.id)
      state = {
        ...state,
        runs: [{ ...sourceRun, status: input.terminalStatus, complete: true }],
      }
      return { completion: Promise.resolve() }
    },
    conversations: {
      branches: {
        cleanup: async (input) => {
          events.push('checkpoint-cleanup')
          cleanupInputs.push(input)
          return { checkpoint: 'deleted', environment: 'not_requested' }
        },
      },
    },
  }
  const adapters = {
    freshEnvironment: async (environmentId) => {
      assert.equal(environmentId, 'sandbox-source')
      if (!sourceExists) return null
      return {
        destroy: async () => {
          events.push('source-destroy')
          sourceExists = false
        },
      }
    },
  }

  const result = await cleanupWorkspaceProofResources({
    cleanupOwner: { app },
    adapters,
    source: { run: sourceRun, providerId: 'sandbox-source' },
    branchOperationId: 'op-live-09-fork',
    proofId: 'live-09-cleanup',
  })

  assert.deepEqual(events, ['checkpoint-cleanup', 'source-cancel', 'source-destroy'])
  assert.deepEqual(cleanupInputs, [
    {
      operationId: 'op-live-required-live-09-cleanup-cleanup',
      checkpointId: 'checkpoint-live-09-cleanup',
    },
  ])
  assert.equal(result.cleanupResult?.checkpoint, 'deleted')
  assert.equal(result.sourceDestroyed, true)
  assert.equal(sourceExists, false)
  assert.equal(state.runs[0].status, 'aborted')
})

test('LIVE-09 failure cleanup recovers a provider fork by its durable request digest', async () => {
  const branchOperationId = 'op-live-09-fork-recovery'
  const sourceRun = {
    id: 'run-live-09-fork-recovery',
    environmentId: 'environment-local-source',
    status: 'running',
    complete: false,
    controlRef: {
      provider: 'tangle-sandbox',
      environmentId: 'sandbox-source-recovery',
      sessionId: 'session-live-09-recovery',
      executionId: 'execution-live-09-recovery',
      runId: 'run-live-09-fork-recovery',
      requestDigest: DIGEST,
    },
  }
  const plan = {
    sourceBranchId: 'branch-source-recovery',
    destinationBranchId: 'branch-destination-recovery',
    placement: { kind: 'provider' },
  }
  const checkpointMaterial = {
    source: sourceRun.controlRef,
    name: `braid checkpoint ${plan.sourceBranchId}`,
    metadata: {
      braidOperationId: branchOperationId,
      sourceBranchId: plan.sourceBranchId,
    },
  }
  const checkpointRef = {
    checkpointId: 'provider-checkpoint-recovery',
    provider: sourceRun.controlRef.provider,
    source: sourceRun.controlRef,
    idempotencyKey: `${branchOperationId}:checkpoint`,
    requestDigest: workspaceCheckpointRequestDigest(checkpointMaterial),
    createdAt: AT,
    metadata: checkpointMaterial.metadata,
  }
  const forkMaterial = {
    checkpoint: checkpointRef,
    name: `braid fork ${plan.destinationBranchId}`,
    placement: plan.placement,
    metadata: {
      braidOperationId: branchOperationId,
      destinationBranchId: plan.destinationBranchId,
    },
  }
  const forkRequest = {
    ...forkMaterial,
    idempotencyKey: `${branchOperationId}:fork`,
    requestDigest: workspaceForkRequestDigest(forkMaterial),
  }
  const forkEnvironment = {
    provider: sourceRun.controlRef.provider,
    environmentId: 'sandbox-destination-recovery',
    sourceEnvironmentId: sourceRun.controlRef.environmentId,
    source: sourceRun.controlRef,
    sourceCheckpointId: checkpointRef.checkpointId,
    idempotencyKey: forkRequest.idempotencyKey,
    requestDigest: forkRequest.requestDigest,
    createdAt: AT,
    placement: forkRequest.placement,
    confidentialRequested: false,
    metadata: forkRequest.metadata,
  }
  let state = {
    runs: [sourceRun],
    checkpoints: [
      { id: 'checkpoint-live-09-fork-recovery', operationId: branchOperationId, createdAt: AT },
    ],
    operations: [
      {
        id: branchOperationId,
        result: {
          providerCheckpointId: checkpointRef.checkpointId,
          forkRequestDigest: forkRequest.requestDigest,
        },
      },
    ],
  }
  const calls = []
  let sourceExists = true
  const app = {
    state: () => state,
    cancelRun: async (input) => {
      calls.push(['source-cancel', input.runId])
      state = {
        ...state,
        runs: [{ ...sourceRun, status: input.terminalStatus, complete: true }],
      }
      return { completion: Promise.resolve() }
    },
    conversations: {
      branches: {
        cleanup: async (input) => {
          calls.push(['checkpoint-cleanup', input.checkpointId])
          assert.equal(input.environmentId, undefined)
          return { checkpoint: 'deleted', environment: 'not_requested' }
        },
      },
    },
  }
  const adapters = {
    freshBranching: async (sourceProviderId) => {
      assert.equal(sourceProviderId, sourceRun.controlRef.environmentId)
      return {
        lookupFork: async (input) => {
          calls.push(['fork-lookup', input])
          return { status: 'found', ...input, environment: forkEnvironment }
        },
        destroyFork: async (input) => {
          calls.push(['fork-destroy', input])
          const material = {
            kind: 'fork',
            targetId: forkEnvironment.environmentId,
            provider: forkEnvironment.provider,
          }
          return {
            operationId: input.operationId,
            kind: 'fork',
            targetId: material.targetId,
            provider: material.provider,
            requestDigest: workspaceCleanupRequestDigest(material),
            status: 'deleted',
          }
        },
      }
    },
    freshEnvironment: async (environmentId) => {
      assert.equal(environmentId, sourceRun.controlRef.environmentId)
      if (!sourceExists) return null
      return {
        destroy: async () => {
          calls.push(['source-destroy'])
          sourceExists = false
        },
      }
    },
  }

  const result = await cleanupWorkspaceProofResources({
    cleanupOwner: { app },
    adapters,
    source: { run: sourceRun, providerId: sourceRun.controlRef.environmentId },
    plan,
    branchOperationId,
    proofId: 'live-09-fork-recovery',
  })

  assert.deepEqual(result.cleanupResult, { checkpoint: 'deleted', environment: 'deleted' })
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['checkpoint-cleanup', 'fork-lookup', 'fork-destroy', 'source-cancel', 'source-destroy'],
  )
  assert.equal(calls[1][1].idempotencyKey, forkRequest.idempotencyKey)
  assert.equal(calls[1][1].requestDigest, forkRequest.requestDigest)
  assert.equal(sourceExists, false)
  assert.equal(state.runs[0].status, 'aborted')
})

test('LIVE-10 policy parsing is typed, bounded, and immutable', () => {
  const parsed = parseConfidentialTrustPolicy(policyEnvironment())
  assert.deepEqual(parsed, {
    policy: {
      acceptedMeasurements: [DIGEST, SECOND_DIGEST],
      acceptedPolicyIds: ['tangle-confidential-v1', 'tangle-confidential-v2'],
      maxAgeSeconds: 300,
    },
    selectedPolicyId: 'tangle-confidential-v1',
  })
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.policy), true)
  assert.equal(Object.isFrozen(parsed.policy.acceptedMeasurements), true)
  assert.equal(Object.isFrozen(parsed.policy.acceptedPolicyIds), true)
})

test('LIVE-10 requires an explicit boolean branching capability', () => {
  assert.equal(confidentialBranchingCapability({ branching: { confidential: false } }), false)
  assert.equal(confidentialBranchingCapability({ branching: { confidential: true } }), true)
  assert.throws(
    () => confidentialBranchingCapability({ branching: {} }),
    /requires provider capabilities\.branching\.confidential as a boolean/u,
  )
  assert.throws(
    () => confidentialBranchingCapability({ branching: { confidential: 'false' } }),
    /ambiguous/u,
  )
})

test('LIVE-10 refusal requires no durable branch mutation or census change', () => {
  const stateDigest = 'a'.repeat(64)
  const changedStateDigest = 'b'.repeat(64)
  const plan = {
    allowed: false,
    environment: 'unavailable',
    checkpoint: 'unavailable',
    confidential: { requested: true },
    destinationEnvironmentId: undefined,
  }
  assert.deepEqual(
    confidentialRefusalChecks({
      plan,
      beforeStateDigest: stateDigest,
      afterStateDigest: stateDigest,
      executeErrorCode: 'CAPABILITY_UNAVAILABLE',
    }),
    {
      actionRefused: true,
      noOrdinaryPlacementDowngrade: true,
      noChildOrCheckpointCreated: true,
    },
  )
  assert.deepEqual(
    resourceCensusComparison(
      { count: 1, ids: ['source'], resources: [{ id: 'source', status: 'running' }] },
      { count: 1, ids: ['source'], resources: [{ id: 'source', status: 'stopped' }] },
    ),
    { activeResourceDelta: 0, unchanged: true },
  )
  assert.deepEqual(
    resourceCensusComparison(
      { count: 1, ids: ['source'], resources: [{ id: 'source', status: 'running' }] },
      { count: 1, ids: ['replacement'], resources: [{ id: 'replacement', status: 'running' }] },
    ),
    { activeResourceDelta: 0, unchanged: false },
  )
  assert.equal(
    confidentialRefusalChecks({
      plan,
      beforeStateDigest: stateDigest,
      afterStateDigest: changedStateDigest,
      executeErrorCode: 'CAPABILITY_UNAVAILABLE',
    }).noChildOrCheckpointCreated,
    false,
  )
})

const invalidPolicyCases = [
  ['missing measurements', { BRAID_TANGLE_CONFIDENTIAL_MEASUREMENTS: undefined }],
  ['malformed measurement', { BRAID_TANGLE_CONFIDENTIAL_MEASUREMENTS: 'not-a-digest' }],
  ['duplicate measurement', { BRAID_TANGLE_CONFIDENTIAL_MEASUREMENTS: `${DIGEST},${DIGEST}` }],
  ['malformed policy id', { BRAID_TANGLE_CONFIDENTIAL_POLICY_IDS: 'not a policy' }],
  [
    'duplicate policy id',
    { BRAID_TANGLE_CONFIDENTIAL_POLICY_IDS: 'tangle-confidential-v1,tangle-confidential-v1' },
  ],
  [
    'selected id is not allowlisted',
    { BRAID_TANGLE_CONFIDENTIAL_POLICY_ID: 'tangle-confidential-v3' },
  ],
  ['age below bound', { BRAID_TANGLE_CONFIDENTIAL_MAX_AGE_SECONDS: '0' }],
  ['age above bound', { BRAID_TANGLE_CONFIDENTIAL_MAX_AGE_SECONDS: '86401' }],
  ['age is not an integer', { BRAID_TANGLE_CONFIDENTIAL_MAX_AGE_SECONDS: '60.5' }],
]

for (const [label, overrides] of invalidPolicyCases) {
  test(`LIVE-10 rejects ${label}`, () => {
    assert.throws(() => parseConfidentialTrustPolicy(policyEnvironment(overrides)))
  })
}

test('LIVE-10 rejects the legacy executable module without a typed policy', () => {
  assert.throws(() =>
    parseConfidentialTrustPolicy({
      BRAID_TANGLE_TEE_VERIFIER_MODULE: './untrusted-verifier.mjs',
    }),
  )
})

test('LIVE-10 has no executable verifier module hook', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../scripts/live-required/tangle-workspace-proof.mjs', import.meta.url)),
    'utf8',
  )
  assert.doesNotMatch(source, /BRAID_TANGLE_(?:TEE|CONFIDENTIAL)_VERIFIER_MODULE/u)
  assert.doesNotMatch(source, /import\(pathToFileURL\(modulePath\)/u)
})

test('LIVE-10 passed receipts require external verification and every negative check', () => {
  const receipt = proofReceipt({
    invocationId: 'live-required-confidential-receipt',
    operation: PROOF_OPERATIONS.tangleConfidential,
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: '2026-08-28T00:00:01.000Z',
    config: {
      endpoint: 'https://sandbox.tangle.tools',
      connectionId: 'connection-live-10',
      connectionKind: 'tangle-sandbox',
      credentialConfigured: true,
      model: 'glm-5.2',
      modelProvider: 'tangle-router',
      runner: 'opencode',
    },
    runIds: ['run-live-10'],
    environmentId: 'local-environment-live-10',
    facts: {
      sourceProviderEnvironmentId: 'sandbox-source-live-10',
      destinationProviderEnvironmentId: 'sandbox-destination-live-10',
      capabilityAdvertised: true,
      capabilityConsistent: true,
      confidentialRequested: true,
      confidentialVerified: true,
      confidentialActionRefused: false,
      noOrdinaryPlacementDowngrade: true,
      noChildOrCheckpointCreated: false,
      missingAttestationRejected: true,
      wrongNonceRejected: true,
      wrongMeasurementRejected: true,
      selfEchoRejected: true,
      activeResourceDelta: 0,
      cleanupCheckpoint: 'deleted',
      cleanupEnvironment: 'deleted',
    },
    checks: [
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
    ],
    observations: {
      capability: {
        providerBranchingConfidential: true,
        sourceBranchingConfidential: true,
        consistent: true,
      },
      attestation: {
        providerKeyAuthenticated: true,
        signatureDistinctFromQuote: true,
        requestedUnverifiedBeforeExecution: true,
        wrongNonceRejected: true,
        wrongMeasurementRejected: true,
        selfEchoRejected: true,
      },
      resourceCensus: {
        before: {
          count: 0,
          ids: [],
          resources: [],
        },
        after: {
          count: 0,
          ids: [],
          resources: [],
        },
        activeResourceDelta: 0,
        unchanged: true,
      },
    },
    environment: {},
  })
  assert.equal(assertProofReceipt(receipt).status, 'passed')
})

test('LIVE-10 passed refusal receipts prove fail-closed capability handling', () => {
  const receipt = proofReceipt({
    invocationId: 'live-required-confidential-refusal-receipt',
    operation: PROOF_OPERATIONS.tangleConfidential,
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: '2026-08-28T00:00:01.000Z',
    config: {
      endpoint: 'https://sandbox.tangle.tools',
      connectionId: 'connection-live-10',
      connectionKind: 'tangle-sandbox',
      credentialConfigured: true,
      model: 'glm-5.2',
      modelProvider: 'tangle-router',
      runner: 'opencode',
    },
    runIds: ['run-live-10'],
    environmentId: 'local-environment-live-10',
    facts: {
      sourceProviderEnvironmentId: 'sandbox-source-live-10',
      destinationProviderEnvironmentId: null,
      capabilityAdvertised: false,
      capabilityConsistent: true,
      confidentialRequested: true,
      confidentialVerified: false,
      confidentialActionRefused: true,
      noOrdinaryPlacementDowngrade: true,
      noChildOrCheckpointCreated: true,
      missingAttestationRejected: null,
      wrongNonceRejected: null,
      wrongMeasurementRejected: null,
      selfEchoRejected: null,
      activeResourceDelta: 0,
      cleanupCheckpoint: null,
      cleanupEnvironment: null,
    },
    checks: [
      'configuration',
      'capability',
      'confidential-refusal',
      'no-ordinary-downgrade',
      'no-child-or-checkpoint',
      'resource-census',
      'cleanup',
    ],
    observations: {
      capability: {
        providerBranchingConfidential: false,
        sourceBranchingConfidential: false,
        consistent: true,
      },
      refusal: {
        executeErrorCode: 'CAPABILITY_UNAVAILABLE',
        stateBeforeDigest: 'a'.repeat(64),
        stateAfterDigest: 'a'.repeat(64),
      },
      resourceCensus: {
        before: { count: 0, ids: [], resources: [] },
        after: { count: 0, ids: [], resources: [] },
        activeResourceDelta: 0,
        unchanged: true,
      },
    },
    environment: {},
  })
  assert.equal(assertProofReceipt(receipt).status, 'passed')
})

test('LIVE-10 receipts reject a replaced resource id hidden by stale census summaries', () => {
  const receipt = proofReceipt({
    invocationId: 'live-required-confidential-census-receipt',
    operation: PROOF_OPERATIONS.tangleConfidential,
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: '2026-08-28T00:00:01.000Z',
    config: {
      endpoint: 'https://sandbox.tangle.tools',
      connectionId: 'connection-live-10',
      connectionKind: 'tangle-sandbox',
      credentialConfigured: true,
      model: 'glm-5.2',
      modelProvider: 'tangle-router',
      runner: 'opencode',
    },
    runIds: ['run-live-10'],
    environmentId: 'local-environment-live-10',
    facts: {
      sourceProviderEnvironmentId: 'sandbox-source-live-10',
      destinationProviderEnvironmentId: null,
      capabilityAdvertised: false,
      capabilityConsistent: true,
      confidentialRequested: true,
      confidentialVerified: false,
      confidentialActionRefused: true,
      noOrdinaryPlacementDowngrade: true,
      noChildOrCheckpointCreated: true,
      missingAttestationRejected: null,
      wrongNonceRejected: null,
      wrongMeasurementRejected: null,
      selfEchoRejected: null,
      activeResourceDelta: 0,
      cleanupCheckpoint: null,
      cleanupEnvironment: null,
    },
    checks: [
      'configuration',
      'capability',
      'confidential-refusal',
      'no-ordinary-downgrade',
      'no-child-or-checkpoint',
      'resource-census',
      'cleanup',
    ],
    observations: {
      capability: {
        providerBranchingConfidential: false,
        sourceBranchingConfidential: false,
        consistent: true,
      },
      refusal: {
        executeErrorCode: 'CAPABILITY_UNAVAILABLE',
        stateBeforeDigest: 'a'.repeat(64),
        stateAfterDigest: 'a'.repeat(64),
      },
      resourceCensus: {
        before: {
          count: 1,
          ids: ['source'],
          resources: [{ id: 'source', status: 'running' }],
        },
        after: {
          count: 1,
          ids: ['source'],
          resources: [{ id: 'source', status: 'running' }],
        },
        activeResourceDelta: 0,
        unchanged: true,
      },
    },
    environment: {},
  })
  const tampered = structuredClone(receipt)
  tampered.observations.resourceCensus.after.ids = ['replacement']
  tampered.observations.resourceCensus.after.resources = [{ id: 'replacement', status: 'running' }]
  assert.throws(
    () => assertProofReceipt(tampered),
    /resource census does not match its derived result/u,
  )
})
