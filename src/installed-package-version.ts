import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

interface PackageDocument {
  readonly name?: unknown
  readonly version?: unknown
}

/** Read package metadata beside the installed entry point without trusting a version constant. */
export function installedPackageVersion(packageName: string): string {
  const require = createRequire(import.meta.url)
  try {
    let directory = dirname(require.resolve(packageName))
    for (let depth = 0; depth < 4; depth += 1) {
      try {
        const document = JSON.parse(
          readFileSync(join(directory, 'package.json'), 'utf8'),
        ) as PackageDocument
        if (
          document.name === packageName &&
          typeof document.version === 'string' &&
          document.version.length > 0
        ) {
          return document.version
        }
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code !== 'ENOENT') throw error
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  } catch {
    // Evidence must say unavailable when installed metadata cannot be verified.
  }
  return 'unavailable'
}
