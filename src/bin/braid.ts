#!/usr/bin/env node

import { enableCompileCache } from 'node:module'
import { CliUsageError, HELP, parseArgs } from './args.js'

async function launch(): Promise<number> {
  let options: ReturnType<typeof parseArgs>
  try {
    options = parseArgs(process.argv.slice(2), process.cwd())
  } catch (error) {
    const message =
      error instanceof CliUsageError
        ? error.message
        : await import('../domain/redaction.js').then(({ redactProviderError }) =>
            redactProviderError(error),
          )
    process.stderr.write(`error: ${message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    const { BRAID_VERSION } = await import('../version.js')
    process.stdout.write(`${BRAID_VERSION}\n`)
    return 0
  }
  enableCompileCache()
  const { runBraid } = await import('./braid-runtime.js')
  return runBraid(options)
}

launch()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch(async (error: unknown) => {
    const { formatProductionStartupError } = await import('./production-startup.js')
    process.stderr.write(`${formatProductionStartupError(error)}\n`)
    process.exitCode = 1
  })
