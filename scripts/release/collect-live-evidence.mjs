import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { collectReleaseEvidence } from './collector.mjs'

const PROCESS_INJECTION_NAMES = new Set([
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const repository = resolve(
  option('--repository') ??
    process.env.BRAID_RELEASE_CHECKOUT ??
    new URL('../../', import.meta.url).pathname,
)
const artifactRootValue = option('--artifact-root') ?? process.env.BRAID_RELEASE_ARTIFACT_ROOT
const tarballPath = option('--tarball')
const checks = option('--checks')
const protectedEnvironment = process.env.BRAID_LIVE_TANGLE_ENV_JSON
assert(artifactRootValue, '--artifact-root is required')
assert(tarballPath, '--tarball is required')
assert(checks, '--checks is required')
assert(protectedEnvironment, 'BRAID_LIVE_TANGLE_ENV_JSON is required')

let parsedEnvironment
try {
  parsedEnvironment = JSON.parse(protectedEnvironment)
} catch (error) {
  throw new Error('BRAID_LIVE_TANGLE_ENV_JSON is not valid JSON', { cause: error })
}
assert(
  parsedEnvironment && typeof parsedEnvironment === 'object' && !Array.isArray(parsedEnvironment),
  'BRAID_LIVE_TANGLE_ENV_JSON must contain an object',
)
for (const [name, value] of Object.entries(parsedEnvironment)) {
  assert(/^[A-Z][A-Z0-9_]*$/u.test(name), `Protected live environment name is invalid: ${name}`)
  assert(
    !PROCESS_INJECTION_NAMES.has(name),
    `Protected live environment name is not allowed: ${name}`,
  )
  assert(typeof value === 'string', `Protected live environment ${name} is not text`)
}
const environment = { ...process.env, ...parsedEnvironment }
delete environment.BRAID_LIVE_TANGLE_ENV_JSON

const requirementBindingsPath = option('--requirements') ?? 'release/requirement-bindings.json'
const requirementBindings = JSON.parse(
  await readFile(resolve(repository, requirementBindingsPath), 'utf8'),
)
const checkIds = checks
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0)
assert(checkIds.length > 0, '--checks must contain at least one check')

const result = await collectReleaseEvidence({
  repository,
  artifactRoot: resolve(artifactRootValue),
  tarballPath: resolve(artifactRootValue, tarballPath),
  requirementBindings,
  checkIds,
  environment,
})
process.stdout.write(
  `Collected ${result.envelope.checks.length} live release checks with result ${result.result}.\n`,
)
if (result.result !== 'passed') process.exitCode = 1
