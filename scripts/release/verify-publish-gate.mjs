import { resolve } from 'node:path'

import { verifyLive10Candidate } from './publish-gate.mjs'

function required(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  return value
}

const repository = resolve(
  process.env.BRAID_RELEASE_CHECKOUT ?? new URL('../../', import.meta.url).pathname,
)
const expectedCommit = required('BRAID_RELEASE_EXPECT_COMMIT')
const expectedVersion = required('BRAID_RELEASE_EXPECT_VERSION')
if (!/^[a-f0-9]{40}$/u.test(expectedCommit))
  throw new Error('BRAID_RELEASE_EXPECT_COMMIT must be a full SHA')

const result = await verifyLive10Candidate({
  repository,
  candidateRoot: resolve(required('BRAID_RELEASE_CANDIDATE_ROOT')),
  liveEvidenceRoot: resolve(required('BRAID_RELEASE_LIVE_EVIDENCE_ROOT')),
  expectedCommit,
  expectedVersion,
})
process.stdout.write(
  `LIVE-10 release gate passed for ${result.candidate.identity.gitCommit} ${result.candidate.identity.tarballSha256}\n`,
)
