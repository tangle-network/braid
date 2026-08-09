import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import { CliUsageError, parseArgs } from '../src/bin/args.js'

async function repositoryRoot(): Promise<URL> {
  const candidates = [new URL('../', import.meta.url), new URL('../../', import.meta.url)]
  for (const candidate of candidates) {
    try {
      await access(new URL('package.json', candidate))
      return candidate
    } catch {}
  }
  throw new Error('Could not locate the Braid repository root')
}

test('expected command-line mistakes remain actionable without echoing arbitrary values', () => {
  assert.throws(
    () => parseArgs(['--workspace'], '/workspace'),
    (error: unknown) =>
      error instanceof CliUsageError && error.message === '--workspace requires a value',
  )
  assert.throws(
    () => parseArgs(['--fixture', 'secret-canary'], '/workspace'),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.message === '--fixture supports only "deterministic"' &&
      !error.message.includes('secret-canary'),
  )
  assert.throws(
    () => parseArgs(['secret-canary'], '/workspace'),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.message === 'Unknown command; expected "rpc" or an option' &&
      !error.message.includes('secret-canary'),
  )
  assert.throws(
    () => parseArgs(['--not-a-real-option'], '/workspace'),
    (error: unknown) =>
      error instanceof CliUsageError && error.message === 'Unknown option: --not-a-real-option',
  )
})

test('startup responsibilities stay split into bounded modules', async () => {
  const root = await repositoryRoot()
  const modules = [
    ['src/bin/braid.ts', 50],
    ['src/bin/braid-runtime.ts', 200],
    ['src/bin/interface-runner.ts', 300],
  ] as const

  for (const [path, maximumLines] of modules) {
    const source = await readFile(new URL(path, root), 'utf8')
    assert.ok(
      source.split('\n').length <= maximumLines,
      `${path} should stay at or below ${maximumLines} lines`,
    )
  }

  const launcher = await readFile(new URL('src/bin/braid.ts', root), 'utf8')
  const staticImports = [...launcher.matchAll(/^import .* from ['"]([^'"]+)['"]$/gmu)].map(
    (match) => match[1],
  )
  assert.deepEqual(staticImports, ['node:module', './args.js'])
  const compileCacheIndex = launcher.indexOf('enableCompileCache()')
  const runtimeImportIndex = launcher.indexOf("import('./braid-runtime.js')")
  assert.ok(compileCacheIndex > launcher.indexOf('if (options.version)'))
  assert.ok(runtimeImportIndex > compileCacheIndex)

  const runtime = await readFile(new URL('src/bin/braid-runtime.ts', root), 'utf8')
  const interfaceRunner = await readFile(new URL('src/bin/interface-runner.ts', root), 'utf8')
  const startupBuild = await readFile(new URL('scripts/build-startup.mjs', root), 'utf8')
  assert.match(runtime, /connections: production\.connections/u)
  assert.match(interfaceRunner, /input\.profileConnectionOptions/u)
  assert.match(startupBuild, /minifySyntax: true/u)
  assert.match(startupBuild, /minifyWhitespace: true/u)
  assert.match(startupBuild, /minifyIdentifiers: false/u)
})
