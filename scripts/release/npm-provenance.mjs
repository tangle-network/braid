import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { assert, canonicalJson } from '../release-evidence.mjs'
import { readRegularFileNoFollow } from '../release-files.mjs'

const PROVENANCE_PREDICATE = 'https://slsa.dev/provenance/v1'
const EXPECTED_REPOSITORY = 'https://github.com/tangle-network/braid'
const EXPECTED_WORKFLOW = '.github/workflows/release.yml'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('hex')
}

function decodePayload(bundle) {
  const encoded = bundle?.bundle?.dsseEnvelope?.payload
  assert(typeof encoded === 'string' && encoded.length > 0, 'npm provenance has no DSSE payload')
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch (error) {
    throw new Error('npm provenance DSSE payload is invalid', { cause: error })
  }
}

function packageSubjectName(version) {
  return `pkg:npm/%40tangle-network/braid@${version}`
}

export function validateNpmAuditDocument(document, { packageProof, tarballSha512 }) {
  assert(
    document && typeof document === 'object' && !Array.isArray(document),
    'npm audit output is not an object',
  )
  assert(
    Array.isArray(document.invalid) && document.invalid.length === 0,
    'npm audit found invalid signatures',
  )
  assert(
    Array.isArray(document.missing) && document.missing.length === 0,
    'npm audit found missing signatures',
  )
  assert(Array.isArray(document.verified), 'npm audit has no verified package list')
  const matches = document.verified.filter(
    (entry) => entry?.name === '@tangle-network/braid' && entry?.version === packageProof.version,
  )
  assert(matches.length === 1, 'npm audit did not uniquely verify the released Braid version')
  const entry = matches[0]
  assert(
    entry.attestations?.provenance?.predicateType === PROVENANCE_PREDICATE,
    'Braid has no verified npm provenance attestation',
  )
  const provenanceBundles = (entry.attestationBundles ?? []).filter(
    (bundle) => bundle?.predicateType === PROVENANCE_PREDICATE,
  )
  assert(provenanceBundles.length === 1, 'Braid does not have one verified provenance bundle')
  const payload = decodePayload(provenanceBundles[0])
  assert(payload.predicateType === PROVENANCE_PREDICATE, 'npm provenance predicate differs')
  const subjects = Array.isArray(payload.subject) ? payload.subject : []
  const subject = subjects.find(
    (candidate) => candidate?.name === packageSubjectName(packageProof.version),
  )
  assert(subject, 'npm provenance does not name the released Braid package')
  assert(subject.digest?.sha512 === tarballSha512, 'npm provenance archive digest differs')
  const workflow = payload.predicate?.buildDefinition?.externalParameters?.workflow
  assert(workflow?.repository === EXPECTED_REPOSITORY, 'npm provenance repository differs')
  assert(workflow?.path === EXPECTED_WORKFLOW, 'npm provenance workflow differs')
  const dependencies = payload.predicate?.buildDefinition?.resolvedDependencies
  assert(Array.isArray(dependencies), 'npm provenance has no resolved source dependency')
  assert(
    dependencies.some(
      (dependency) =>
        dependency?.uri === `git+${EXPECTED_REPOSITORY}@${workflow.ref}` &&
        dependency?.digest?.gitCommit === packageProof.gitCommit,
    ),
    'npm provenance does not bind the released Braid commit',
  )
  const builder = payload.predicate?.runDetails?.builder?.id
  assert(
    builder === 'https://github.com/actions/runner/github-hosted',
    'npm provenance was not built on a GitHub-hosted runner',
  )
  const invocationId = payload.predicate?.runDetails?.metadata?.invocationId
  assert(
    typeof invocationId === 'string' &&
      invocationId.startsWith(`${EXPECTED_REPOSITORY}/actions/runs/`),
    'npm provenance workflow invocation differs',
  )
  return {
    package: entry.name,
    version: entry.version,
    predicateType: PROVENANCE_PREDICATE,
    subject: subject.name,
    tarballSha512,
    repository: workflow.repository,
    workflow: workflow.path,
    ref: workflow.ref,
    gitCommit: packageProof.gitCommit,
    builder,
    invocationId,
  }
}

export async function readAndValidateNpmProvenance({ artifactRoot, packageProof }) {
  const root = resolve(artifactRoot)
  const auditPath = join(root, 'publication', 'npm-audit-signatures.json')
  const tarballPath = join(root, 'candidate', packageProof.tarball)
  const [auditBytes, tarballBytes] = await Promise.all([
    readRegularFileNoFollow(auditPath),
    readRegularFileNoFollow(tarballPath),
  ])
  let document
  try {
    document = JSON.parse(auditBytes.toString('utf8'))
  } catch (error) {
    throw new Error('npm audit signature output is invalid JSON', { cause: error })
  }
  const summary = validateNpmAuditDocument(document, {
    packageProof,
    tarballSha512: sha512(tarballBytes),
  })
  return {
    summary,
    artifact: {
      id: 'publication-npm-provenance',
      path: 'publication/npm-audit-signatures.json',
      sha256: sha256(auditBytes),
      mediaType: 'application/json',
    },
    canonicalDigest: sha256(Buffer.from(canonicalJson(summary))),
  }
}

export async function packageProofForProvenance(artifactRoot) {
  return JSON.parse(await readFile(join(resolve(artifactRoot), 'w6', 'package-proof.json'), 'utf8'))
}
