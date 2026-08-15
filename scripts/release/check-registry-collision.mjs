import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readRegularFileNoFollow } from '../release-files.mjs'
import { executeArgv } from './command-runner.mjs'
import { npmInvocation } from './platform.mjs'

const NOT_FOUND_PATTERN = /(?:E404|404\s+Not Found|not in this registry|no match found)/iu
const BRAID_PACKAGE_SPEC = /^@tangle-network\/braid@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function outputText(result) {
  return `${Buffer.from(result?.stdout?.bytes ?? []).toString('utf8')}\n${Buffer.from(result?.stderr?.bytes ?? []).toString('utf8')}`
}

function assertCommandSucceeded(result, label) {
  assert(result?.exitCode === 0, `${label} failed: ${outputText(result).trim()}`)
  assert(result.signal === null, `${label} terminated by ${result.signal}`)
  assert(result.timedOut !== true, `${label} timed out`)
  assert(result.spawnError === null, `${label} could not start: ${result.spawnError}`)
  assert(result.cleanupConfirmed === true, `${label} did not confirm process cleanup`)
}

function assertCommandSettled(result, label) {
  assert(Number.isInteger(result.exitCode), `${label} did not return an exit code`)
  assert(result.signal === null, `${label} terminated by ${result.signal}`)
  assert(result.timedOut !== true, `${label} timed out`)
  assert(result.spawnError === null, `${label} could not start: ${result.spawnError}`)
  assert(result.cleanupConfirmed === true, `${label} did not confirm process cleanup`)
}

function packedFilename(before, after, packageSpec) {
  const created = after.filter((filename) => !before.has(filename) && filename.endsWith('.tgz'))
  assert(
    created.length === 1,
    `npm pack created ${created.length} tarballs for ${packageSpec}; expected one`,
  )
  const filename = created[0]
  assert(
    basename(filename) === filename,
    `npm pack returned an unsafe tarball name for ${packageSpec}`,
  )
  return filename
}

export async function assertRegistryVersionAvailable({
  packageSpec,
  tarballPath,
  environment = process.env,
  workingDirectory,
  runCommand = executeArgv,
} = {}) {
  assert(
    typeof packageSpec === 'string' && BRAID_PACKAGE_SPEC.test(packageSpec),
    'Registry package spec must be @tangle-network/braid at one semantic version',
  )
  assert(typeof tarballPath === 'string' && tarballPath.length > 0, 'Candidate tarball is required')
  const root = workingDirectory ?? (await mkdtemp(join(tmpdir(), 'braid-registry-collision-')))
  const ownsRoot = workingDirectory === undefined
  const runNpm = (args) => {
    const invocation = npmInvocation(args)
    return runCommand({
      ...invocation,
      cwd: root,
      environment,
    })
  }
  try {
    const candidate = await readRegularFileNoFollow(tarballPath)
    const candidateSha256 = sha256(candidate)
    const view = await runNpm(['view', packageSpec, 'version', '--json'])
    if (view.exitCode !== 0) {
      assertCommandSettled(view, `Registry lookup for ${packageSpec}`)
      assert(
        NOT_FOUND_PATTERN.test(outputText(view)),
        `Registry lookup failed for ${packageSpec}: ${outputText(view).trim()}`,
      )
      return { packageSpec, status: 'available' }
    }
    assertCommandSucceeded(view, `Registry lookup for ${packageSpec}`)

    const beforePack = new Set(await readdir(root))
    const packed = await runNpm([
      'pack',
      '--ignore-scripts',
      '--silent',
      '--pack-destination',
      root,
      packageSpec,
    ])
    assertCommandSucceeded(packed, `Registry tarball download for ${packageSpec}`)
    const filename = packedFilename(beforePack, await readdir(root), packageSpec)
    const existing = await readRegularFileNoFollow(join(root, filename))
    const existingSha256 = sha256(existing)
    if (existingSha256 !== candidateSha256)
      throw new Error(
        `Registry version collision: ${packageSpec} exists with a different tarball (registry ${existingSha256}, candidate ${candidateSha256})`,
      )
    return { packageSpec, status: 'already-published', sha256: candidateSha256 }
  } finally {
    if (ownsRoot) await rm(root, { recursive: true, force: true })
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const packageSpec = option('--package')
  const tarballPath = option('--tarball')
  if (!packageSpec || !tarballPath) throw new Error('--package and --tarball are required')

  const outcome = await assertRegistryVersionAvailable({ packageSpec, tarballPath })
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(outcome)}\n`)
  else if (outcome.status === 'available')
    process.stdout.write(`Registry version ${packageSpec} is available for publication.\n`)
  else
    process.stdout.write(`Registry version ${packageSpec} already contains this exact tarball.\n`)
}
