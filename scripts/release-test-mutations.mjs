import { generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assert, verifyManifestSignature } from './release-evidence.mjs'
import { REQUIRED_PERFORMANCE_TARGETS } from './release-performance.mjs'
import { resignCheck } from './release-test-fixture.mjs'
import { runChildMutations } from './release-test-child-mutations.mjs'
import { expectReject, mutateEvidence, validateFixture } from './release-test-mutation-helpers.mjs'
import {
  runJsonMutations,
  runPathMutations,
  runSpecificationMutations,
} from './release-test-attacks.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function evidenceMutations(fixture, manifest) {
  let attempts = 0
  const mutate = async (label, action) => {
    attempts += 1
    assert(typeof label === 'string' && label.length > 0, 'Mutation has no label')
    await action()
  }

  await mutate('missing requirement', () =>
    mutateEvidence(
      fixture,
      'missing requirement',
      (evidence) => {
        delete evidence.requirements['PR-01']
      },
      /no evidence mapping|mapping set/iu,
    ),
  )
  await mutate('unknown requirement', () =>
    mutateEvidence(
      fixture,
      'unknown requirement',
      (evidence) => {
        evidence.requirements['ZZ-01'] = clone(evidence.requirements['PR-01'])
      },
      /unknown requirement|mapping set/iu,
    ),
  )
  await mutate('duplicate requirement check id', () =>
    mutateEvidence(
      fixture,
      'duplicate requirement check id',
      (evidence) => {
        evidence.checks.push(clone(evidence.checks.find((check) => check.id === 'unit')))
      },
      /duplicate check/iu,
    ),
  )
  await mutate('missing own record', () =>
    mutateEvidence(
      fixture,
      'missing own record',
      (evidence) => {
        evidence.checks = evidence.checks.filter((check) => check.id !== 'PERF-01')
      },
      /requires its own check|unknown check|missing|performance matrix/iu,
    ),
  )
  await mutate('wrong category', () =>
    mutateEvidence(
      fixture,
      'wrong category',
      (evidence) => {
        resignCheck(evidence, 'LIVE-01', { category: 'security' }, fixture.privateKey)
      },
      /category/iu,
    ),
  )
  await mutate('wrong command', () =>
    mutateEvidence(
      fixture,
      'wrong command',
      (evidence) => {
        resignCheck(evidence, 'unit', { command: 'pnpm test:unit -- altered' }, fixture.privateKey)
      },
      /unregistered command|required check.*command/iu,
    ),
  )
  await mutate('reused check', () =>
    mutateEvidence(
      fixture,
      'reused check',
      (evidence) => {
        evidence.requirements['PR-01'].checks.push('unit')
      },
      /reused|unreferenced/iu,
    ),
  )
  await mutate('generic check reassignment', () =>
    mutateEvidence(
      fixture,
      'generic check reassignment',
      (evidence) => {
        evidence.requirements['AR-03'].checks = evidence.requirements['AR-03'].checks.filter(
          (id) => id !== 'unit',
        )
        evidence.requirements['PR-01'].checks.push('unit')
      },
      /fixed check|assigned/iu,
    ),
  )
  await mutate('reused artifact', () =>
    mutateEvidence(
      fixture,
      'reused artifact',
      (evidence) => {
        evidence.requirements['PR-01'].artifacts.push('PR-02')
      },
      /reused|unreferenced/iu,
    ),
  )
  await mutate('mapped requirement without own check', () =>
    mutateEvidence(
      fixture,
      'mapped requirement without own check',
      (evidence) => {
        evidence.requirements['PR-01'].checks = ['PR-02']
      },
      /does not cite its own|requires its own/iu,
    ),
  )
  await mutate('mapped requirement without own artifact', () =>
    mutateEvidence(
      fixture,
      'mapped requirement without own artifact',
      (evidence) => {
        evidence.requirements['PR-01'].artifacts = ['PR-02']
      },
      /does not cite its own|unique artifact/iu,
    ),
  )
  await mutate('stale timestamp', () =>
    mutateEvidence(
      fixture,
      'stale timestamp',
      (evidence) => {
        resignCheck(
          evidence,
          'unit',
          {
            startedAt: '2025-01-01T00:00:00.000Z',
            completedAt: '2025-01-01T00:00:01.000Z',
          },
          fixture.privateKey,
        )
      },
      /started before/iu,
    ),
  )
  await mutate('cross-build check', () =>
    mutateEvidence(
      fixture,
      'cross-build check',
      (evidence) => {
        resignCheck(evidence, 'unit', { buildSha256: 'b'.repeat(64) }, fixture.privateKey)
      },
      /another build/iu,
    ),
  )
  await mutate('dependency version mismatch', () =>
    mutateEvidence(
      fixture,
      'dependency version mismatch',
      (evidence) => {
        evidence.dependencies[0].version = '2.0.0'
      },
      /version differs/iu,
    ),
  )
  await mutate('dependency integrity mismatch', () =>
    mutateEvidence(
      fixture,
      'dependency integrity mismatch',
      (evidence) => {
        evidence.dependencies[0].integrity = `sha512-${Buffer.alloc(64, 8).toString('base64')}`
      },
      /integrity differs/iu,
    ),
  )
  await mutate('malformed distribution', () =>
    mutateEvidence(
      fixture,
      'malformed distribution',
      (evidence) => {
        const check = evidence.checks.find((candidate) => candidate.id === 'PERF-01')
        const measurements = clone(check.measurements)
        measurements[0].maximum = 'not-a-number'
        resignCheck(evidence, 'PERF-01', { measurements }, fixture.privateKey)
      },
      /finite number/iu,
    ),
  )
  for (const name of Object.keys(REQUIRED_PERFORMANCE_TARGETS)) {
    await mutate(`performance target ${name}`, () =>
      mutateEvidence(
        fixture,
        `performance target ${name}`,
        (evidence) => {
          const check = evidence.checks.find((candidate) => candidate.id === name)
          const measurements = clone(check.measurements)
          measurements[0].target.value += 1
          resignCheck(evidence, name, { measurements }, fixture.privateKey)
        },
        /target differs/iu,
      ),
    )
  }
  await mutate('incomplete environment provenance', () =>
    mutateEvidence(
      fixture,
      'incomplete environment provenance',
      (evidence) => {
        delete evidence.environments[0].details.region
      },
      /region|unknown field/iu,
    ),
  )
  for (const kind of ['unavailable', 'uncaptured']) {
    await mutate(`${kind} measurement`, () =>
      mutateEvidence(
        fixture,
        `${kind} measurement`,
        (evidence) => {
          resignCheck(
            evidence,
            'unit',
            { measurements: [{ kind, name: 'result', reason: 'fixture mutation' }] },
            fixture.privateKey,
          )
        },
        /unavailable|uncaptured/iu,
      ),
    )
  }
  await mutate('null measurement', () =>
    mutateEvidence(
      fixture,
      'null measurement',
      (evidence) => {
        resignCheck(
          evidence,
          'unit',
          { measurements: [{ kind: 'scalar', name: 'result', unit: 'count', value: null }] },
          fixture.privateKey,
        )
      },
      /finite number/iu,
    ),
  )
  await mutate('unresolved cleanup', () =>
    mutateEvidence(
      fixture,
      'unresolved cleanup',
      (evidence) => {
        evidence.cleanup[0].status = 'unresolved'
      },
      /unresolved/iu,
    ),
  )
  await mutate('omitted billable resource', () =>
    mutateEvidence(
      fixture,
      'omitted billable resource',
      (evidence) => {
        evidence.environments[0].details.billableResourceIds = []
      },
      /billable resource/iu,
    ),
  )
  await mutate('omitted live resource inventory', () =>
    mutateEvidence(
      fixture,
      'omitted live resource inventory',
      (evidence) => {
        evidence.environments[0].details.resourceIds = []
      },
      /resource/iu,
    ),
  )
  await mutate('tampered check receipt', () =>
    mutateEvidence(
      fixture,
      'tampered check receipt',
      (evidence) => {
        const receipt = evidence.checks.find((check) => check.id === 'unit').receipt
        receipt.signature = `${receipt.signature.slice(0, -1)}${receipt.signature.endsWith('A') ? 'B' : 'A'}`
      },
      /signature|payload/iu,
    ),
  )
  const { publicKey: wrongPublicKey } = generateKeyPairSync('ed25519')
  await mutate('wrong trust root', () =>
    mutateEvidence(
      fixture,
      'wrong trust root',
      (evidence) => evidence,
      /untrusted key|key/iu,
      wrongPublicKey,
    ),
  )
  await expectReject(
    () => verifyManifestSignature({ ...manifest, braidVersion: '9.9.9' }, fixture.publicKey),
    'tampered manifest',
    /payload changed|signature/iu,
  )
  attempts += 1

  const tarballPath = join(fixture.root, 'artifacts/verification/w6/fixture-package.tgz')
  const tarball = await readFile(tarballPath)
  await writeFile(tarballPath, Buffer.concat([tarball, Buffer.from('tampered')]))
  try {
    attempts += 1
    await expectReject(
      () => validateFixture(fixture, fixture.evidence),
      'altered package tarball',
      /digest changed/iu,
    )
  } finally {
    await writeFile(tarballPath, tarball)
  }

  attempts += await runChildMutations(fixture)
  await runSpecificationMutations(fixture)
  attempts += 3
  await runPathMutations()
  attempts += 9
  await runJsonMutations()
  attempts += 12
  return { attempts, rejected: attempts, failed: 0, skipped: 0 }
}

export async function runMutations(fixture, manifest) {
  return evidenceMutations(fixture, manifest)
}
