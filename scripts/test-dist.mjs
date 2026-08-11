import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(fileURLToPath(new URL('../', import.meta.url)))
const TEST_DIST_PREFIX = '.test-dist-'

function assertRunDirectory(path) {
  const resolved = resolve(path)
  if (dirname(resolved) !== repository || !basename(resolved).startsWith(TEST_DIST_PREFIX)) {
    throw new Error('BRAID_TEST_DIST must name one test directory below the repository')
  }
  return resolved
}

export async function createTestDist(prefix) {
  if (!/^[a-z0-9-]+$/u.test(prefix)) throw new Error('Test directory prefix is invalid')
  return mkdtemp(join(repository, `${TEST_DIST_PREFIX}${prefix}-`))
}

export function configuredTestDist(environment = process.env) {
  const path = environment.BRAID_TEST_DIST
  if (!path) throw new Error('BRAID_TEST_DIST is required')
  return assertRunDirectory(path)
}

export async function resetTestDist(path) {
  const resolved = assertRunDirectory(path)
  await rm(resolved, { force: true, recursive: true })
  await mkdir(resolved, { recursive: true })
}

export async function removeTestDist(path) {
  await rm(assertRunDirectory(path), { force: true, recursive: true })
}
