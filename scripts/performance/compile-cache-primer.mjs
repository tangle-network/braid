import { constants as moduleConstants, enableCompileCache, flushCompileCache } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [packageRoot, cacheDirectory] = process.argv.slice(2)
if (!packageRoot || !cacheDirectory)
  throw new Error('Compile-cache primer requires packed package and cache directories')

const result = enableCompileCache(cacheDirectory)
const statusName =
  Object.entries(moduleConstants.compileCacheStatus).find(
    ([, value]) => value === result.status,
  )?.[0] ?? `UNKNOWN_${result.status}`
if (
  result.status === moduleConstants.compileCacheStatus.FAILED ||
  result.status === moduleConstants.compileCacheStatus.DISABLED
) {
  throw new Error(
    `Could not prime Node compile cache: ${statusName}: ${result.message ?? 'unknown'}`,
  )
}

await Promise.all([
  import(pathToFileURL(join(packageRoot, 'dist/startup/durable-runtime.js')).href),
  import(pathToFileURL(join(packageRoot, 'dist/startup/terminal-runtime.js')).href),
])
flushCompileCache()

process.stdout.write(
  `${JSON.stringify({
    status: statusName,
    modules: ['dist/startup/durable-runtime.js', 'dist/startup/terminal-runtime.js'],
    flushed: true,
  })}\n`,
)
