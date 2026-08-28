import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type {
  AgentExactRunControlRef,
  ConfidentialAttestation,
  ConfidentialExecutionEnvironment,
} from '@tangle-network/agent-interface'
import { canonicalAgentProfileDigest, defineAgentProfile } from '@tangle-network/agent-interface'
import type { SandboxTeeAttestationReportLike } from '@tangle-network/agent-provider-tangle'
import { encodeTangleConfidentialAttestationQuote } from '@tangle-network/agent-provider-tangle'
import {
  createNitroHardwareVerifier,
  parseNitroAttestationDocument,
  toHex,
  verifyAttestation,
} from '@tangle-network/tcloud-attestation'
import { AWS_NITRO_ENCLAVES_ROOT_G1_PEM } from '../src/adapters/connections/aws-nitro-root-g1.js'
import {
  createNitroConfidentialAttestationVerifiers,
  normalizeNitroConfidentialAttestationTrustPolicy,
} from '../src/adapters/connections/nitro-confidential-attestation.js'
import { ConnectionRegistry, mergeConnectionTelemetry } from '../src/app/connections.js'
import { createProfileRecord } from '../src/app/profiles.js'
import {
  persistProductionStartupSelection,
  saveProductionStartupSelection,
} from '../src/bin/production-setup-persistence.js'
import { loadProductionStartup } from '../src/bin/production-startup.js'
import type {
  ConfidentialAttestationTrustPolicy,
  ConnectionRecord,
} from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures/aws-nitro-document.cbor',
)
const fixtureEvidence = Uint8Array.from(readFileSync(fixturePath))
const fixtureDocument = parseNitroAttestationDocument(fixtureEvidence)
const fixtureTimestamp = Math.floor(fixtureDocument.timestamp / 1000)
const fixtureMeasurement = fixtureDocument.pcrs.get(0)
const fixtureNonce = fixtureDocument.nonce
if (fixtureMeasurement === undefined || fixtureNonce === undefined) {
  throw new Error('The AWS Nitro fixture is incomplete')
}
const fixtureMeasurementBytes: Uint8Array = fixtureMeasurement
const fixtureNonceBytes: Uint8Array = fixtureNonce
const fixtureMeasurementDigest =
  `sha256:${createHash('sha256').update(fixtureMeasurementBytes).digest('hex')}` as const

const policy: ConfidentialAttestationTrustPolicy = Object.freeze({
  acceptedMeasurements: Object.freeze([fixtureMeasurementDigest]),
  acceptedPolicyIds: Object.freeze(['tangle-confidential-v1']),
  maxAgeSeconds: 300,
})

const source: AgentExactRunControlRef = {
  runId: 'run-nitro-adapter',
  provider: 'tangle-sandbox',
  environmentId: 'environment-source',
  sessionId: 'session-nitro-adapter',
  executionId: 'execution-nitro-adapter',
  requestDigest: `sha256:${'1'.repeat(64)}`,
}

const expected: ConfidentialExecutionEnvironment = {
  provider: 'tangle-sandbox',
  environmentId: 'environment-destination',
  source,
  requestDigest: `sha256:${'2'.repeat(64)}`,
  confidentialRequested: true,
}

function report(): SandboxTeeAttestationReportLike {
  return {
    tee_type: 'nitro',
    evidence: [...fixtureEvidence],
    measurement: [...fixtureMeasurementBytes],
    timestamp: fixtureTimestamp,
  }
}

function quote() {
  const encoded = encodeTangleConfidentialAttestationQuote(report())
  if (encoded === undefined)
    throw new Error('The AWS Nitro fixture quote is outside provider bounds')
  return encoded
}

function pendingAttestation(): ConfidentialAttestation {
  return {
    provider: expected.provider,
    requested: true as const,
    nonce: toHex(fixtureNonceBytes),
    measurement: fixtureMeasurementDigest,
    environmentId: expected.environmentId,
    source,
    requestDigest: expected.requestDigest,
    profileDigest: `sha256:${'3'.repeat(64)}`,
    policy: 'tangle-confidential-v1',
    quote: quote(),
    providerKeyId: 'unverified',
    providerSignature: 'unverified',
    verifiedAt: new Date(fixtureTimestamp * 1000).toISOString(),
  }
}

function connection(
  id: string,
  confidentialAttestationPolicy?: ConfidentialAttestationTrustPolicy,
): ConnectionRecord {
  return {
    id: createConnectionId(`connection-${id}`),
    kind: 'tangle-sandbox',
    name: `Tangle Sandbox ${id}`,
    endpoint: 'https://sandbox.tangle.tools',
    ...(confidentialAttestationPolicy === undefined ? {} : { confidentialAttestationPolicy }),
    providerOptions: { transport: 'https', lifecycle: 'retained', idleTtlSeconds: 300 },
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    lastHealth: { status: 'unknown' },
  }
}

test('Nitro adapter verifies the real COSE quote and derives stable provider identity', async () => {
  const verifiers = createNitroConfidentialAttestationVerifiers(policy, {
    now: () => fixtureTimestamp,
  })
  const attestation = pendingAttestation()
  const first = await verifiers.tangle({ report: report(), expected, attestation })
  const second = await verifiers.tangle({ report: report(), expected, attestation })
  assert.deepEqual(first, second)
  assert.ok(first)
  assert.match(first.providerKeyId, /^sha256:[0-9a-f]{64}$/u)
  assert.match(first.providerSignature, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(first.measurement, fixtureMeasurementDigest)

  const persisted = { ...attestation, ...first }
  assert.equal(verifiers.canonical(structuredClone(persisted), structuredClone(expected)), true)
  assert.equal(verifiers.canonical(JSON.parse(JSON.stringify(persisted)), expected), true)
  assert.equal(
    verifiers.canonical({ ...persisted, providerKeyId: `sha256:${'0'.repeat(64)}` }, expected),
    false,
  )
  assert.equal(
    verifiers.canonical({ ...persisted, providerSignature: `sha256:${'0'.repeat(64)}` }, expected),
    false,
  )
})

test('Nitro adapter rejects every mutated trust input and binding', async () => {
  const verifiers = createNitroConfidentialAttestationVerifiers(policy, {
    now: () => fixtureTimestamp,
  })
  const attestation = pendingAttestation()
  const verify = (
    candidate = attestation,
    candidateExpected = expected,
    candidateReport = report(),
  ) =>
    verifiers.tangle({
      report: candidateReport,
      expected: candidateExpected,
      attestation: candidate,
    })

  assert.equal((await verify({ ...attestation, nonce: '0'.repeat(64) })) ?? null, null)
  assert.equal(
    (await verify({ ...attestation, measurement: `sha256:${'f'.repeat(64)}` })) ?? null,
    null,
  )
  assert.equal(
    (await verify(attestation, expected, {
      ...report(),
      evidence: [...fixtureEvidence.slice(0, -1), 0],
    })) ?? null,
    null,
  )
  const rootBytes = new X509Certificate(AWS_NITRO_ENCLAVES_ROOT_G1_PEM).raw
  const rootOffset = Buffer.from(fixtureEvidence).indexOf(Buffer.from(rootBytes))
  if (rootOffset < 0) throw new Error('The AWS Nitro fixture does not contain the pinned root')
  const wrongRootEvidence = [...fixtureEvidence]
  const rootByte = wrongRootEvidence[rootOffset]
  if (rootByte === undefined) throw new Error('The AWS Nitro fixture root index is invalid')
  wrongRootEvidence[rootOffset] = (rootByte + 1) % 256
  assert.equal(
    (await verify(attestation, expected, { ...report(), evidence: wrongRootEvidence })) ?? null,
    null,
  )
  assert.equal(
    (await verify(attestation, expected, { ...report(), timestamp: fixtureTimestamp - 301 })) ??
      null,
    null,
  )
  assert.equal(
    (await verify(attestation, { ...expected, provider: 'other-provider' })) ?? null,
    null,
  )
  assert.equal(
    (await verify(attestation, { ...expected, environmentId: 'environment-other' })) ?? null,
    null,
  )
  assert.equal(
    (await verify(attestation, { ...expected, requestDigest: `sha256:${'4'.repeat(64)}` })) ?? null,
    null,
  )
  assert.equal(
    (await verify(attestation, {
      ...expected,
      source: { ...source, executionId: 'execution-other' },
    })) ?? null,
    null,
  )
  assert.equal((await verify({ ...attestation, policy: 'policy-not-allowed' })) ?? null, null)
  assert.equal(
    (await verify({ ...attestation, quote: `${attestation.quote.slice(0, -1)}A` })) ?? null,
    null,
  )
  const persisted = {
    ...attestation,
    ...(await verifiers.tangle({ report: report(), expected, attestation })),
  }
  assert.equal(
    verifiers.canonical({ ...persisted, quote: `${persisted.quote.slice(0, -1)}A` }, expected),
    false,
  )

  const staleVerifiers = createNitroConfidentialAttestationVerifiers(policy, {
    now: () => fixtureTimestamp + 301,
  })
  assert.equal(await staleVerifiers.tangle({ report: report(), expected, attestation }), null)

  const shortFreshnessPolicy: ConfidentialAttestationTrustPolicy = {
    ...policy,
    maxAgeSeconds: 60,
  }
  const forgedTimestamp = fixtureTimestamp + 61
  const forgedReport: SandboxTeeAttestationReportLike = {
    ...report(),
    timestamp: forgedTimestamp,
  }
  const forgedAttestation: ConfidentialAttestation = {
    ...attestation,
    quote: (() => {
      const encoded = encodeTangleConfidentialAttestationQuote(forgedReport)
      if (encoded === undefined) throw new Error('The forged quote is outside provider bounds')
      return encoded
    })(),
    verifiedAt: new Date(forgedTimestamp * 1000).toISOString(),
  }
  const signedQuoteStillVerifies = verifyAttestation(forgedReport, {
    acceptedTeeTypes: ['nitro'],
    acceptedMeasurements: [toHex(fixtureMeasurementBytes)],
    maxAgeSeconds: 60,
    now: forgedTimestamp,
    hardwareVerifier: createNitroHardwareVerifier({
      trustedRootCertificates: [new X509Certificate(AWS_NITRO_ENCLAVES_ROOT_G1_PEM).raw],
      nowMs: forgedTimestamp * 1000,
      maxTimestampSkewSeconds: 300,
    }),
  })
  assert.equal(signedQuoteStillVerifies.valid, true)
  const shortFreshnessVerifiers = createNitroConfidentialAttestationVerifiers(
    shortFreshnessPolicy,
    { now: () => forgedTimestamp },
  )
  assert.equal(
    await shortFreshnessVerifiers.tangle({
      report: forgedReport,
      expected,
      attestation: forgedAttestation,
    }),
    null,
  )
})

test('Nitro policy requires explicit bounded allowlists and has no unverified path', () => {
  assert.throws(
    () =>
      normalizeNitroConfidentialAttestationTrustPolicy({
        acceptedMeasurements: [],
        acceptedPolicyIds: ['tangle-confidential-v1'],
        maxAgeSeconds: 300,
      }),
    /requires one to 256 canonical SHA-256 measurements/u,
  )
  assert.throws(
    () =>
      normalizeNitroConfidentialAttestationTrustPolicy({
        acceptedMeasurements: [`sha256:${'a'.repeat(64)}`],
        acceptedPolicyIds: [],
        maxAgeSeconds: 300,
      }),
    /requires one to 256 canonical policy ids/u,
  )
  assert.throws(
    () =>
      normalizeNitroConfidentialAttestationTrustPolicy({
        acceptedMeasurements: [`sha256:${'a'.repeat(64)}`],
        acceptedPolicyIds: ['tangle-confidential-v1'],
        maxAgeSeconds: 86_401,
      }),
    /maxAgeSeconds/u,
  )
  const normalized = normalizeNitroConfidentialAttestationTrustPolicy(policy)
  assert.equal(Object.isFrozen(normalized), true)
  assert.equal(Object.isFrozen(normalized.acceptedMeasurements), true)
  assert.equal(Object.isFrozen(normalized.acceptedPolicyIds), true)
})

test('connection policy is secret-free, immutable, and telemetry-safe when omitted or changed', () => {
  const configured = connection('policy', policy)
  const registry = new ConnectionRegistry([configured])
  const selected = registry.get(configured.id)
  assert.ok(selected)
  assert.deepEqual(selected.confidentialAttestationPolicy, policy)
  assert.equal(Object.isFrozen(selected.confidentialAttestationPolicy), true)
  assert.equal(Object.isFrozen(selected.confidentialAttestationPolicy.acceptedMeasurements), true)
  assert.equal(Object.isFrozen(selected.confidentialAttestationPolicy.acceptedPolicyIds), true)

  const ordinary = connection('ordinary')
  assert.doesNotThrow(() => mergeConnectionTelemetry(ordinary, ordinary))
  assert.equal(mergeConnectionTelemetry(ordinary, ordinary).id, ordinary.id)
  const changed = connection('policy', {
    ...policy,
    acceptedPolicyIds: ['tangle-confidential-v2'],
  })
  assert.equal(mergeConnectionTelemetry(configured, changed).confidentialAttestationPolicy, policy)
})

test('connection policy survives persisted startup selection and restart unchanged', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'braid-nitro-policy-'))
  try {
    const configPath = resolve(workspace, '.braid', 'config.json')
    const selected = connection('persisted', policy)
    const profile = defineAgentProfile({
      name: 'Nitro persistence test',
      description: 'A profile used for startup policy persistence',
      harness: 'pi',
      model: { default: 'openai/gpt-5', provider: 'openai' },
    })
    const profileRecord = createProfileRecord(
      {
        kind: 'inline',
        reference: 'nitro-test',
        label: 'Nitro test profile',
        writable: false,
        trusted: true,
      },
      profile,
    )
    const selection = {
      profile: profileRecord,
      connection: selected,
      profileDigest: canonicalAgentProfileDigest(profile),
      connectionDigest: `sha256:${'5'.repeat(64)}`,
    } as const
    await saveProductionStartupSelection(configPath, selection, { connections: [selected] })
    const serialized = await readFile(configPath, 'utf8')
    assert.match(serialized, /tangle-confidential-v1/u)
    assert.match(serialized, /sha256:[0-9a-f]{64}/u)
    assert.doesNotMatch(
      serialized,
      /BEGIN CERTIFICATE|BEGIN [A-Z ]*PRIVATE KEY|secret-canary|quote/iu,
    )
    const loaded = await loadProductionStartup({ workspace, configPath })
    assert.deepEqual(loaded.connections[0]?.confidentialAttestationPolicy, policy)

    const oldDocument = JSON.parse(serialized) as {
      schemaVersion: number
      connections: Array<Record<string, unknown>>
    }
    oldDocument.schemaVersion = 1
    delete oldDocument.connections[0]?.confidentialAttestationPolicy
    await writeFile(configPath, `${JSON.stringify(oldDocument)}\n`, 'utf8')
    const migrated = await loadProductionStartup({ workspace, configPath })
    assert.equal(migrated.connections[0]?.confidentialAttestationPolicy, undefined)

    const persisted = await persistProductionStartupSelection(configPath, selection, {
      connections: [selected],
    })
    try {
      const restarted = await loadProductionStartup({ workspace, configPath })
      assert.deepEqual(restarted.connections[0], selected)
      assert.deepEqual(restarted.connections[0]?.confidentialAttestationPolicy, policy)
    } finally {
      await persisted.rollback()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
