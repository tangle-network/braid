import { createRequire } from 'node:module'

interface PackageDocument {
  readonly name?: unknown
  readonly version?: unknown
}

function packageVersion(): string {
  const require = createRequire(import.meta.url)
  // dist/version.js, src/version.ts under the test build, and the esbuild startup chunks in
  // dist/startup/chunks/ each sit at a different depth below the package root.
  for (const path of ['../package.json', '../../package.json', '../../../package.json']) {
    try {
      const document = require(path) as PackageDocument
      if (
        document.name === '@tangle-network/braid' &&
        typeof document.version === 'string' &&
        document.version.length > 0
      ) {
        return document.version
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error('Braid package version is unavailable')
}

export const BRAID_VERSION = packageVersion()
