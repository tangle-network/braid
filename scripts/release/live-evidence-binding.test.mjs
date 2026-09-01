import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  assertProofReceipt,
  PROOF_OPERATIONS,
  proofReceipt,
  tangleReceiptsArtifact,
} from '../live-required/contracts.mjs'
import { runtimeModuleRoot } from '../live-required/tangle-workspace-proof.mjs'
import {
  assertLiveEvidenceBinding,
  liveEvidenceBinding,
  serializedLiveEvidenceBinding,
} from './live-evidence-binding.mjs'
import { assertTangleReceipts } from './live-tangle-proof.mjs'

const identity = {
  braidVersion: '0.3.0',
  gitCommit: 'a'.repeat(40),
  tarballSha256: 'b'.repeat(64),
  packageIntegrity: `sha512-${'A'.repeat(88)}`,
  dependencyDigest: 'c'.repeat(64),
  dependencies: [
    {
      name: '@tangle-network/agent-runtime',
      version: '0.185.2',
      integrity: `sha512-${'B'.repeat(88)}`,
    },
  ],
}

function receipt(environment) {
  return proofReceipt({
    invocationId: 'live-required-test-invocation',
    operation: PROOF_OPERATIONS.tangleInference,
    startedAt: '2026-09-01T00:00:00.000Z',
    completedAt: '2026-09-01T00:00:01.000Z',
    runIds: ['run-1', 'run-2'],
    facts: { normalRunId: 'run-1', cancelledRunId: 'run-2' },
    checks: ['normal-turn', 'cancelled-turn', 'materialization-receipt'],
    observations: { provider: 'real' },
    environment,
  })
}

test('proof receipts accept the exact candidate binding and reject a stale Runtime version', () => {
  const environment = {
    BRAID_RELEASE_LIVE_EVIDENCE_BINDING: serializedLiveEvidenceBinding(identity),
  }
  const bound = receipt(environment)
  assert.equal(bound.releaseBinding.runtimeVersion, '0.185.2')
  assert.doesNotThrow(() => assertProofReceipt(bound))

  assert.throws(
    () =>
      assertLiveEvidenceBinding(
        {
          ...bound.releaseBinding,
          runtimeVersion: '0.185.1',
        },
        identity,
        'LIVE-10 evidence',
      ),
    /differs/u,
  )
})

test('proof receipts without a release binding remain valid outside collection', () => {
  const unbound = receipt({})
  assert.equal(Object.hasOwn(unbound, 'releaseBinding'), false)
  assert.doesNotThrow(() => assertProofReceipt(unbound))
  assert.deepEqual(
    liveEvidenceBinding(identity),
    JSON.parse(serializedLiveEvidenceBinding(identity)),
  )
})

test('candidate-bound workspace proofs reject source Runtime modules and stale aggregate rows', () => {
  const environment = {
    BRAID_RELEASE_LIVE_EVIDENCE_BINDING: serializedLiveEvidenceBinding(identity),
  }
  assert.throws(
    () => runtimeModuleRoot('/work/braid', environment),
    (error) => error.code === 'BRAID_PACKED_PACKAGE_REQUIRED',
  )
  for (const sourcePath of ['/work/braid/dist', '/work/braid/other']) {
    assert.throws(
      () =>
        runtimeModuleRoot('/work/braid', { ...environment, BRAID_LIVE_PACKAGE_ROOT: sourcePath }),
      (error) => error.code === 'BRAID_PACKED_PACKAGE_REQUIRED',
    )
  }
  const packageRoot = '/tmp/braid-install/node_modules/@tangle-network/braid'
  assert.equal(
    runtimeModuleRoot('/work/braid', { ...environment, BRAID_LIVE_PACKAGE_ROOT: packageRoot }),
    `${packageRoot}/dist`,
  )

  const evidence = receipt(environment)
  const aggregate = tangleReceiptsArtifact([
    { row: 'LIVE-06', status: 'passed', evidence },
    ...['LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10'].map((row) => ({
      row,
      status: 'unavailable',
      reason: 'fixture row not exercised',
    })),
  ])
  assert.doesNotThrow(() => assertTangleReceipts(aggregate, identity))
  const stale = structuredClone(aggregate)
  stale.flows.find(({ row }) => row === 'LIVE-06').evidence.releaseBinding.runtimeVersion =
    '0.185.1'
  assert.throws(() => assertTangleReceipts(stale, identity), /differs/u)
})
