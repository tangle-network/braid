import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, join, relative } from 'node:path'

import { configuredTestDist } from './test-dist.mjs'

const root = join(configuredTestDist(), 'test')

async function testsUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return testsUnder(path)
      return extname(path) === '.js' && path.endsWith('.test.js') ? [path] : []
    }),
  )
  return nested.flat()
}

const tests = (await testsUnder(root)).sort()
if (tests.length === 0) {
  process.stderr.write('No compiled tests found\n')
  process.exit(1)
}

const scopeIndex = process.argv.indexOf('--scope')
const scope = scopeIndex === -1 ? undefined : process.argv[scopeIndex + 1]
const listOnly = process.argv.includes('--list')
if (scopeIndex !== -1 && !scope) {
  process.stderr.write('--scope requires a test scope\n')
  process.exit(1)
}

const scopeFiles = {
  unit: [
    'agent-interface-runtime-parity.test.js',
    'analysis-model-call-observability.test.js',
    'analysis-model-call-roundtrip.test.js',
    'application.test.js',
    'cli-startup.test.js',
    'conversations.test.js',
    'coordination.test.js',
    'domain-ids.test.js',
    'domain-invariants.test.js',
    'domain-reducer.test.js',
    'domain-text.test.js',
    'eval.test.js',
    'native-interactive-actions.test.js',
    'native-interactive-run-broker.test.js',
    'observability.test.js',
    'plain-accessibility.test.js',
    'property.test.js',
    'reducer.test.js',
    'sanitize.test.js',
    'scripts.test.js',
    'terminal-usage-status.test.js',
    'usage-projection.test.js',
    'w6-ui.test.js',
  ],
  contract: [
    'agent-interface-runtime-parity.test.js',
    'analysis-model-call-observability.test.js',
    'analysis-model-call-roundtrip.test.js',
    'application.test.js',
    'cli-bridge-interactions.test.js',
    'cli-bridge-profile-contract.test.js',
    'cli-bridge-retained-restart.test.js',
    'conversations.test.js',
    'coordination.test.js',
    'domain-invariants.test.js',
    'domain-reducer.test.js',
    'observability.test.js',
    'reducer.test.js',
    'retained-execution-lifecycle.test.js',
    'scripts.test.js',
    'tangle-retained-lifecycle.test.js',
    'usage-projection.test.js',
    'w6-contract.test.js',
  ],
  coordination: [
    'analysis-durable.test.js',
    'cli-bridge-interactions.test.js',
    'cli-bridge-retained-restart.test.js',
    'coordination.test.js',
    'effect-admission.test.js',
    'run-admission-architecture.test.js',
    'run-interactions.test.js',
    'tangle-retained-lifecycle.test.js',
  ],
  rpc: [
    'automation-interaction-commands.test.js',
    'profile-connection-actions.test.js',
    'rpc.test.js',
    'w6-contract.test.js',
  ],
  'virtual-terminal': [
    'activity-document.test.js',
    'configuration-product-flow.test.js',
    'intelligence-dispatch.test.js',
    'keyboard.test.js',
    'native-interactive-command.test.js',
    'terminal-responsive.test.js',
    'terminal-usage-status.test.js',
    'tui-autocomplete.test.js',
    'tui-conversations.test.js',
    'tui-core-workflows.test.js',
    'tui-interaction-security.test.js',
    'tui-refresh-lifecycle.test.js',
    'tui.test.js',
    'w6-ui.test.js',
  ],
  storage: [
    'conversation-storage.test.js',
    'coordination.test.js',
    'domain-reducer.test.js',
    'effect-admission.test.js',
    'storage-crash.test.js',
    'storage-snapshots.test.js',
    'storage.test.js',
  ],
  security: [
    'analysis-model-call-observability.test.js',
    'analysis-model-call-roundtrip.test.js',
    'cli-startup.test.js',
    'configuration-product-flow.test.js',
    'conversations.test.js',
    'coordination.test.js',
    'observability.test.js',
    'plain-accessibility.test.js',
    'profile-connection-actions.test.js',
    'profile-save-recovery.test.js',
    'sanitize.test.js',
    'security.test.js',
    'storage-snapshots.test.js',
    'storage.test.js',
    'tui-core-workflows.test.js',
    'tui-interaction-security.test.js',
    'w6-contract.test.js',
  ],
  crash: [
    'cli-bridge-retained-restart.test.js',
    'conversation-storage.test.js',
    'profile-save-recovery.test.js',
    'storage-crash.test.js',
    'storage.test.js',
  ],
  performance: [
    'coordination.test.js',
    'performance.test.js',
    'reducer.test.js',
    'storage-performance.test.js',
  ],
  property: ['property.test.js'],
}
const selectedTests =
  scope === undefined
    ? tests
    : tests.filter((path) => scopeFiles[scope]?.includes(relative(root, path)))
if (scope !== undefined && selectedTests.length === 0) {
  process.stderr.write(`No compiled tests registered for scope ${scope}\n`)
  process.exit(1)
}

if (listOnly) {
  process.stdout.write(`${JSON.stringify(selectedTests.map((path) => relative(root, path)))}\n`)
  process.exit(0)
}

const nativeStorageRequired = selectedTests.some(
  (path) =>
    path.endsWith('/conversation-storage.test.js') ||
    path.endsWith('/storage.test.js') ||
    path.endsWith('/storage-crash.test.js') ||
    path.endsWith('/storage-performance.test.js') ||
    path.endsWith('/effect-admission.test.js'),
)
if (nativeStorageRequired) {
  try {
    createRequire(import.meta.url).resolve('better-sqlite3-multiple-ciphers')
  } catch {
    process.stderr.write(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@13.0.3 is not installed; install dependencies with lifecycle scripts before running storage or crash tests\n',
    )
    process.exit(2)
  }
}

const isolatedPerformanceFiles = new Set(['performance.test.js', 'storage-performance.test.js'])
const isolatedTests = selectedTests.filter((path) =>
  isolatedPerformanceFiles.has(relative(root, path)),
)
const concurrentTests = selectedTests.filter(
  (path) => !isolatedPerformanceFiles.has(relative(root, path)),
)

function runTestBatch(paths) {
  if (paths.length === 0) return 0
  const result = spawnSync(process.execPath, ['--test', ...paths], { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

let status = runTestBatch(concurrentTests)
for (const path of isolatedTests) {
  if (status !== 0) break
  status = runTestBatch([path])
}
process.exit(status)
