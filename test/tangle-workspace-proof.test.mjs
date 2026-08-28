import assert from 'node:assert/strict'
import test from 'node:test'

import {
  workspaceCheckpointRequestDigest,
  workspaceForkRequestDigest,
} from '@tangle-network/agent-interface'

import {
  assertProofReceipt,
  PROOF_OPERATIONS,
  proofReceipt,
} from '../scripts/live-required/contracts.mjs'
import { confidentialNegativeChecks } from '../scripts/live-required/tangle-workspace-proof.mjs'

const DIGEST = `sha256:${'1'.repeat(64)}`

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
      runner: 'opencode',
    },
    runIds: ['run-live-10'],
    environmentId: 'local-environment-live-10',
    facts: {
      sourceProviderEnvironmentId: 'sandbox-source-live-10',
      destinationProviderEnvironmentId: 'sandbox-destination-live-10',
      confidentialRequested: true,
      confidentialVerified: true,
      missingAttestationRejected: true,
      wrongNonceRejected: true,
      wrongMeasurementRejected: true,
      cleanupCheckpoint: 'deleted',
      cleanupEnvironment: 'deleted',
    },
    checks: [
      'configuration',
      'external-verifier',
      'requested-unverified-binding',
      'missing-attestation',
      'valid-attestation',
      'wrong-nonce',
      'wrong-measurement',
      'cleanup',
    ],
    observations: { verified: true },
    environment: {},
  })
  assert.equal(assertProofReceipt(receipt).status, 'passed')
})
