import { writeFile } from 'node:fs/promises'
import { constants as moduleConstants, enableCompileCache } from 'node:module'
import { pathToFileURL } from 'node:url'
import { FileCredentialStore } from './file-credential-store.mjs'

const epochNow = () => performance.timeOrigin + performance.now()
const startup = {
  processStartEpochMs: performance.timeOrigin,
  scriptReadyEpochMs: epochNow(),
}

const compileCache = enableCompileCache()
startup.compileCacheReadyEpochMs = epochNow()
startup.compileCacheStatus =
  Object.entries(moduleConstants.compileCacheStatus).find(
    ([, value]) => value === compileCache.status,
  )?.[0] ?? `UNKNOWN_${compileCache.status}`
startup.compileCacheEnabled =
  compileCache.status === moduleConstants.compileCacheStatus.ENABLED ||
  compileCache.status === moduleConstants.compileCacheStatus.ALREADY_ENABLED

const [databasePath, workspaceRoot, keyPath, credentialRoot, packageRoot] = process.argv.slice(2)
if (!databasePath || !workspaceRoot || !keyPath || !credentialRoot || !packageRoot)
  throw new Error(
    'Packed production TUI child requires database, workspace, key, credentials, and package paths',
  )

const applicationRuntime = await import(
  pathToFileURL(`${packageRoot}/dist/startup/durable-runtime.js`).href
)
startup.applicationModulesReadyEpochMs = epochNow()

const profile = { name: 'Braid performance profile', harness: 'pi' }
const connection = {
  id: 'connection-performance-local',
  kind: 'cli-bridge',
  name: 'Performance local bridge',
  endpoint: 'http://127.0.0.1:9',
  providerOptions: { transport: 'local' },
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
  lastHealth: { status: 'unknown' },
}
const credentials = new FileCredentialStore(credentialRoot)
const application = applicationRuntime
  .createDurableBraidApplication({
    path: databasePath,
    workspaceRoot,
    credentialStore: credentials,
    databaseKeySource: { type: 'file', path: keyPath, workspaceRoot },
    profile,
    production: {
      profile,
      connections: [connection],
      connectionId: connection.id,
      connectionOptions: { credentials },
    },
  })
  .then((value) => {
    startup.applicationReadyEpochMs = epochNow()
    return value
  })
const terminalModules = import(
  pathToFileURL(`${packageRoot}/dist/startup/terminal-runtime.js`).href
).then((value) => {
  startup.terminalModulesReadyEpochMs = epochNow()
  return value
})
const [durable, terminalRuntime] = await Promise.all([application, terminalModules])

const controller = terminalRuntime.createApplicationUiController(durable.app, {
  color: 'none',
  reducedMotion: true,
})
const terminal = new terminalRuntime.ProcessTerminal()
const tui = new terminalRuntime.TuiMainScreen(terminal)
const terminalApp = new terminalRuntime.BraidTerminalApp({
  controller,
  tui,
  theme: terminalRuntime.createBraidTheme({ colors: false, reducedMotion: true }),
  workspace: workspaceRoot,
  nextOperationId: (() => {
    let next = 0
    return () => `op-perf-production-ui-${++next}`
  })(),
})
startup.terminalReadyEpochMs = epochNow()

let started = false
const stop = () => {
  if (started) terminalApp.stop()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  const initialized = await controller.initialize(workspaceRoot)
  if (initialized.kind !== 'accepted') throw new Error(initialized.reason ?? initialized.message)
  startup.initializedEpochMs = epochNow()
  if (process.env.BRAID_STARTUP_TIMING_PATH) {
    await writeFile(process.env.BRAID_STARTUP_TIMING_PATH, `${JSON.stringify(startup)}\n`, {
      mode: 0o600,
    })
  }
  started = true
  await terminalApp.start()
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  if (started) terminalApp.stop()
  await durable.app.close().catch(() => undefined)
}
