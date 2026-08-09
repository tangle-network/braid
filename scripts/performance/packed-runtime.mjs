import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function moduleUrl(packageRoot, relativePath) {
  return pathToFileURL(join(packageRoot, relativePath)).href
}

export function installedPackageRoot(packed) {
  return join(packed.installRoot, 'node_modules', '@tangle-network', 'braid')
}

export async function loadPackedRuntime(packageRoot) {
  if (typeof packageRoot !== 'string' || packageRoot.length === 0)
    throw new Error('PERF_PREREQUISITE: packed Braid package root is required')
  const [index, clock, journal, journalSupport, materializedState, state, tui, terminal, theme] =
    await Promise.all([
      import(moduleUrl(packageRoot, 'dist/index.js')),
      import(moduleUrl(packageRoot, 'dist/ports/clock.js')),
      import(moduleUrl(packageRoot, 'dist/app/storage-journal.js')),
      import(moduleUrl(packageRoot, 'dist/app/storage-journal-support.js')),
      import(moduleUrl(packageRoot, 'dist/domain/materialized-state-snapshot.js')),
      import(moduleUrl(packageRoot, 'dist/domain/state.js')),
      import(moduleUrl(packageRoot, 'dist/adapters/tui/application-ui-controller.js')),
      import(moduleUrl(packageRoot, 'dist/views/tui/terminal-app.js')),
      import(moduleUrl(packageRoot, 'dist/views/tui/theme.js')),
    ])
  return Object.freeze({
    index,
    clock,
    journal,
    journalSupport,
    materializedState,
    state,
    tui,
    terminal,
    theme,
    packageRoot,
  })
}
