import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Identity of the installed canonical schema package.
 *
 * A digest is only reproducible against the schema that produced it, so an
 * exported profile has to name the resolved `agent-interface` version rather
 * than the package name alone. The version is read from the resolved module's
 * own manifest — the package restricts subpath imports, so the manifest is
 * located from the resolved entry point instead of imported.
 */

export interface ProfileSchemaIdentity {
  readonly package: string
  readonly version: string
  readonly digestAlgorithm: 'sha256'
  readonly serialization: 'rfc8785'
}

const PACKAGE_NAME = '@tangle-network/agent-interface'

function resolveInstalledVersion(): string {
  const require = createRequire(import.meta.url)
  let directory = dirname(require.resolve(PACKAGE_NAME))
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        readonly name?: unknown
        readonly version?: unknown
      }
      if (manifest.name === PACKAGE_NAME && typeof manifest.version === 'string') {
        return manifest.version
      }
    } catch {
      // Keep walking: the resolved entry point may sit in a nested dist folder.
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Cannot resolve the installed ${PACKAGE_NAME} version`)
}

let cached: ProfileSchemaIdentity | undefined

/** The resolved canonical schema identity every export and receipt reports. */
export function profileSchemaIdentity(): ProfileSchemaIdentity {
  cached ??= Object.freeze({
    package: PACKAGE_NAME,
    version: resolveInstalledVersion(),
    digestAlgorithm: 'sha256' as const,
    serialization: 'rfc8785' as const,
  })
  return cached
}
