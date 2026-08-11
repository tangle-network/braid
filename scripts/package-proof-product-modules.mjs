import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { configuredTestDist } from './test-dist.mjs'

const repository = resolve(fileURLToPath(new URL('../', import.meta.url)))

export function packageProofProductRoot(environment = process.env, argv = process.argv) {
  if (argv.includes('--parity-self-test') && environment.BRAID_TEST_DIST) {
    return join(configuredTestDist(environment), 'src')
  }
  return join(repository, 'dist')
}

async function productModule(path, environment = process.env, argv = process.argv) {
  const root = packageProofProductRoot(environment, argv)
  return import(pathToFileURL(join(root, ...path)).href)
}

export async function loadPackageProofCanonicalDigest() {
  const module = await productModule(['domain', 'canonical.js'])
  if (typeof module.canonicalDigest !== 'function') {
    throw new TypeError('The compiled product does not export canonicalDigest')
  }
  return module.canonicalDigest
}

export async function loadPackageProofSessionUsage() {
  const module = await productModule(['views', 'shared', 'usage-projection.js'])
  if (typeof module.sessionUsageFor !== 'function') {
    throw new TypeError('The compiled product does not export sessionUsageFor')
  }
  return module.sessionUsageFor
}
