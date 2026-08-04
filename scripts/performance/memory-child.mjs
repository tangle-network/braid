import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileCredentialStore } from './file-credential-store.mjs'

const [databasePath, workspaceRoot, keyPath, credentialRoot, packageRoot] = process.argv.slice(2)
if (!databasePath || !workspaceRoot || !keyPath || !credentialRoot || !packageRoot)
  throw new Error(
    'PERF-09 memory child requires database, workspace, key, credentials, and packed package paths',
  )

const indexUrl = (relativePath) => pathToFileURL(join(packageRoot, relativePath)).href
const [tui, index] = await Promise.all([
  import(indexUrl('dist/adapters/tui/application-ui-controller.js')),
  import(indexUrl('dist/index.js')),
])
const profile = { name: 'Braid performance profile', harness: 'pi' }
const credentials = new FileCredentialStore(credentialRoot)
if (typeof globalThis.gc === 'function') globalThis.gc()
const baselineRssMiB = process.memoryUsage().rss / (1024 * 1024)
const durable = await index.createDurableBraidApplication({
  path: databasePath,
  workspaceRoot,
  credentialStore: credentials,
  databaseKeySource: { type: 'file', path: keyPath, workspaceRoot },
  profile,
})
try {
  const view = tui.buildBraidViewModel(durable.app.state(), 'transcript', { color: 'none' }, false)
  if (typeof globalThis.gc === 'function') globalThis.gc()
  const state = durable.app.state()
  process.stdout.write(
    `${JSON.stringify({
      baselineRssMiB,
      rssMiB: process.memoryUsage().rss / (1024 * 1024),
      eventCount: state.sequence,
      loadedTailEventCount: durable.app.events().length,
      renderedRows: view.messages.length + (view.activity?.length ?? 0),
      recentContent: view.messages.at(-1)?.text ?? state.messages.at(-1)?.text ?? null,
      stateMessageCount: state.messages.length,
      viewMessageCount: view.messages.length,
      stateRunCount: state.runs.length,
      stateRunEventCount: state.runs.at(-1)?.eventCount ?? null,
      stateLastError: state.lastError,
      sequence: state.sequence,
    })}\n`,
  )
} finally {
  await durable.app.close()
}
