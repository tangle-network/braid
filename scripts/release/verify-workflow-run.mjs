import { assert } from '../release-evidence.mjs'

const repository = process.env.GITHUB_REPOSITORY
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
const runId = process.env.BRAID_RELEASE_RUN_ID
const expectedWorkflow = process.env.BRAID_RELEASE_EXPECT_WORKFLOW
const expectedCommit = process.env.BRAID_RELEASE_EXPECT_COMMIT
const expectedBranch = process.env.BRAID_RELEASE_EXPECT_BRANCH ?? 'main'

assert(
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? ''),
  'GITHUB_REPOSITORY is required',
)
assert(typeof token === 'string' && token.length > 0, 'GH_TOKEN is required')
assert(/^\d+$/u.test(runId ?? ''), 'BRAID_RELEASE_RUN_ID must be a numeric run ID')
assert(typeof expectedWorkflow === 'string' && expectedWorkflow.length > 0)
assert(
  /^[a-f0-9]{40}$/u.test(expectedCommit ?? ''),
  'BRAID_RELEASE_EXPECT_COMMIT must be a full SHA',
)
assert(typeof expectedBranch === 'string' && expectedBranch.length > 0)

const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, {
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  },
})
assert(response.ok, `GitHub Actions run lookup failed with HTTP ${response.status}`)
const run = await response.json()
assert(run.path === expectedWorkflow, 'Actions run used another workflow')
assert(run.event === 'workflow_dispatch', 'Actions run was not workflow_dispatch')
assert(run.head_sha === expectedCommit, 'Actions run commit differs from the candidate')
assert(run.head_branch === expectedBranch, 'Actions run branch is not the protected main branch')
assert(run.status === 'completed' && run.conclusion === 'success', 'Actions run did not succeed')

process.stdout.write(
  `Verified ${expectedWorkflow} run ${runId} for ${run.head_sha} on ${run.head_branch}\n`,
)
