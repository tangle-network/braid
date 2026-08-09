import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const GITHUB_API = 'https://api.github.com'
const GITHUB_ACCEPT = 'application/vnd.github+json'
const COMMIT_SHA = /^[a-f0-9]{40}$/u
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/u

const PACKAGE_SPECS = Object.freeze({
  '@tangle-network/agent-interface': Object.freeze({
    repository: 'tangle-network/agent-sdk',
    tag(version) {
      return `@tangle-network/agent-interface@${version}`
    },
  }),
  '@tangle-network/agent-runtime': Object.freeze({
    repository: 'tangle-network/agent-runtime',
    tag(version) {
      return `v${version}`
    },
  }),
  '@tangle-network/agent-provider-cli-bridge': Object.freeze({
    repository: 'tangle-network/agent-sdk',
    tag(version) {
      return `@tangle-network/agent-provider-cli-bridge@${version}`
    },
  }),
  '@tangle-network/agent-provider-tangle': Object.freeze({
    repository: 'tangle-network/agent-sdk',
    tag(version) {
      return `@tangle-network/agent-provider-tangle@${version}`
    },
  }),
})

function owner(packageName, check) {
  return Object.freeze({ package: packageName, check })
}

const INTERFACE = '@tangle-network/agent-interface'
const RUNTIME = '@tangle-network/agent-runtime'
const CLI_BRIDGE = '@tangle-network/agent-provider-cli-bridge'
const TANGLE = '@tangle-network/agent-provider-tangle'

/** Each result must come from the tagged package's owning repository. */
export const UPSTREAM_REQUIREMENT_OWNERS = Object.freeze({
  'UP-01': Object.freeze([owner(INTERFACE, 'UP-01')]),
  'UP-02': Object.freeze([owner(INTERFACE, 'UP-02'), owner(RUNTIME, 'UP-02')]),
  'UP-03': Object.freeze([owner(RUNTIME, 'UP-03')]),
  'UP-04': Object.freeze([owner(RUNTIME, 'UP-04')]),
  'UP-05': Object.freeze([owner(CLI_BRIDGE, 'UP-05')]),
  'UP-06': Object.freeze([owner(CLI_BRIDGE, 'UP-06')]),
  'UP-07': Object.freeze([owner(CLI_BRIDGE, 'UP-07')]),
  'UP-08': Object.freeze([owner(CLI_BRIDGE, 'UP-08')]),
  'UP-09': Object.freeze([owner(TANGLE, 'UP-09')]),
  'UP-10': Object.freeze([owner(RUNTIME, 'UP-10')]),
  'UP-11': Object.freeze([
    owner(INTERFACE, 'UP-11'),
    owner(RUNTIME, 'UP-11'),
    owner(CLI_BRIDGE, 'UP-11'),
    owner(TANGLE, 'UP-11'),
  ]),
  'UP-12': Object.freeze([owner(INTERFACE, 'UP-12'), owner(RUNTIME, 'UP-12')]),
  'UP-13': Object.freeze([owner(INTERFACE, 'UP-13'), owner(RUNTIME, 'UP-13')]),
  'UP-14': Object.freeze([owner(INTERFACE, 'UP-14'), owner(TANGLE, 'UP-14')]),
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function repositoryFromMetadata(repository) {
  const value = typeof repository === 'string' ? repository : repository?.url
  const match = String(value ?? '').match(/github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/u)
  return match?.[1]
}

function checkRunId(detailsUrl, repository) {
  const escaped = repository.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = String(detailsUrl).match(
    new RegExp(`^https://github\\.com/${escaped}/actions/runs/([0-9]+)(?:/|$)`, 'u'),
  )
  return match?.[1]
}

function artifactNamesRequirement(name, requirementId) {
  const escaped = requirementId.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|[^A-Z0-9])${escaped}(?:[^A-Z0-9]|$)`, 'u').test(String(name))
}

function passingCheck(packageRecord, ownerRecord, requirementId) {
  const candidates = (packageRecord.checks ?? [])
    .filter(({ name }) => name === ownerRecord.check)
    .filter(
      (check) =>
        check.status === 'completed' &&
        check.conclusion === 'success' &&
        check.headSha === packageRecord.gitCommit &&
        check.app === 'github-actions' &&
        checkRunId(check.detailsUrl, packageRecord.repository) !== undefined,
    )
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))
  for (const check of candidates) {
    const artifact = (check.artifacts ?? []).find(
      (candidate) =>
        candidate.expired === false &&
        artifactNamesRequirement(candidate.name, requirementId) &&
        ARTIFACT_DIGEST.test(candidate.digest) &&
        String(candidate.archiveDownloadUrl).startsWith(
          `${GITHUB_API}/repos/${packageRecord.repository}/actions/artifacts/`,
        ),
    )
    if (artifact) return { check, artifact }
  }
  return undefined
}

export function evaluateUpstreamRequirementChecks(packages) {
  const failures = []
  const requirements = []
  for (const [requirementId, owners] of Object.entries(UPSTREAM_REQUIREMENT_OWNERS)) {
    const sources = []
    for (const ownerRecord of owners) {
      const packageRecord = packages[ownerRecord.package]
      const specification = PACKAGE_SPECS[ownerRecord.package]
      if (!packageRecord) {
        failures.push(`${requirementId} has no ${ownerRecord.package} package evidence`)
        continue
      }
      if (packageRecord.package !== ownerRecord.package) {
        failures.push(`${requirementId} package key and record differ for ${ownerRecord.package}`)
        continue
      }
      if (packageRecord.repository !== specification.repository) {
        failures.push(`${requirementId} names the wrong repository for ${ownerRecord.package}`)
        continue
      }
      if (!COMMIT_SHA.test(packageRecord.gitCommit)) {
        failures.push(`${requirementId} has no tagged commit for ${ownerRecord.package}`)
        continue
      }
      const passed = passingCheck(packageRecord, ownerRecord, requirementId)
      if (!passed) {
        failures.push(
          `${requirementId} has no successful ${ownerRecord.check} check and retained ${requirementId} artifact for ${ownerRecord.package}@${packageRecord.version}`,
        )
        continue
      }
      sources.push({
        package: ownerRecord.package,
        version: packageRecord.version,
        repository: packageRecord.repository,
        tag: packageRecord.tag,
        gitCommit: packageRecord.gitCommit,
        check: passed.check,
        artifact: passed.artifact,
      })
    }
    if (sources.length === owners.length) requirements.push({ id: requirementId, sources })
  }
  return {
    failures,
    requirements,
    measurements:
      failures.length === 0
        ? requirements.map(({ id, sources }) => ({
            kind: 'scalar',
            name: id,
            unit: 'upstream-attestations',
            value: sources.length,
          }))
        : [],
  }
}

async function githubJson(path, { fetchImpl, token }) {
  const response = await fetchImpl(`${GITHUB_API}${path}`, {
    headers: {
      Accept: GITHUB_ACCEPT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}`)
  return response.json()
}

async function taggedCommit(repository, tag, options) {
  let object = (
    await githubJson(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, options)
  ).object
  for (let depth = 0; object?.type === 'tag' && depth < 4; depth += 1) {
    object = (await githubJson(`/repos/${repository}/git/tags/${object.sha}`, options)).object
  }
  assert(object?.type === 'commit' && COMMIT_SHA.test(object.sha), `${tag} is not a commit tag`)
  return object.sha
}

async function checkRuns(repository, gitCommit, options) {
  const payload = await githubJson(
    `/repos/${repository}/commits/${gitCommit}/check-runs?per_page=100`,
    options,
  )
  assert(
    Number.isInteger(payload.total_count) && payload.total_count <= 100,
    `${repository}@${gitCommit} has more than 100 check runs`,
  )
  assert(Array.isArray(payload.check_runs), `${repository}@${gitCommit} returned no check runs`)
  const artifactCache = new Map()
  const records = []
  for (const check of payload.check_runs) {
    const runId = checkRunId(check.details_url, repository)
    let artifacts = []
    if (runId !== undefined) {
      if (!artifactCache.has(runId)) {
        const artifactPayload = await githubJson(
          `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
          options,
        )
        assert(
          Number.isInteger(artifactPayload.total_count) && artifactPayload.total_count <= 100,
          `${repository} run ${runId} has more than 100 artifacts`,
        )
        artifactCache.set(
          runId,
          (artifactPayload.artifacts ?? []).map((artifact) => ({
            id: artifact.id,
            name: artifact.name,
            digest: artifact.digest,
            expired: artifact.expired,
            archiveDownloadUrl: artifact.archive_download_url,
            createdAt: artifact.created_at,
            expiresAt: artifact.expires_at,
          })),
        )
      }
      artifacts = artifactCache.get(runId)
    }
    records.push({
      id: check.id,
      name: check.name,
      headSha: check.head_sha,
      status: check.status,
      conclusion: check.conclusion,
      app: check.app?.slug,
      detailsUrl: check.details_url,
      startedAt: check.started_at,
      completedAt: check.completed_at,
      artifacts,
    })
  }
  return records
}

async function packageRecord(repositoryRoot, packageName, rootPackage, options) {
  const specification = PACKAGE_SPECS[packageName]
  const declaredVersion = rootPackage.dependencies?.[packageName]
  assert(typeof declaredVersion === 'string', `${packageName} is not a production dependency`)
  const packagePath = join(
    repositoryRoot,
    'node_modules',
    ...packageName.split('/'),
    'package.json',
  )
  const installed = JSON.parse(await readFile(packagePath, 'utf8'))
  assert(installed.name === packageName, `${packageName} resolved to another package`)
  assert(
    installed.version === declaredVersion,
    `${packageName} installed version differs from package.json`,
  )
  assert(
    repositoryFromMetadata(installed.repository) === specification.repository,
    `${packageName} package metadata names another repository`,
  )
  const tag = specification.tag(installed.version)
  const gitCommit = await taggedCommit(specification.repository, tag, options)
  return {
    package: packageName,
    version: installed.version,
    repository: specification.repository,
    tag,
    gitCommit,
    checks: await checkRuns(specification.repository, gitCommit, options),
  }
}

export async function collectUpstreamEvidence({
  repository,
  fetchImpl = fetch,
  token = process.env.BRAID_UPSTREAM_GITHUB_TOKEN,
}) {
  const rootPackage = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
  const options = { fetchImpl, token }
  const packageEntries = await Promise.all(
    Object.keys(PACKAGE_SPECS).map(async (packageName) => [
      packageName,
      await packageRecord(repository, packageName, rootPackage, options),
    ]),
  )
  const packages = Object.fromEntries(packageEntries)
  return {
    schema: 'braid.upstream-evidence.v1',
    collectedAt: new Date().toISOString(),
    packages,
    ...evaluateUpstreamRequirementChecks(packages),
  }
}
