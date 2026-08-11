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

const applicationModules = import(
  pathToFileURL(`${packageRoot}/dist/startup/durable-runtime.js`).href
).then((value) => {
  startup.applicationModulesReadyEpochMs = epochNow()
  return value
})
const previewModules = import(
  pathToFileURL(`${packageRoot}/dist/startup/preview-runtime.js`).href
).then((value) => {
  startup.previewModulesReadyEpochMs = epochNow()
  return value
})
const [applicationRuntime, previewRuntime] = await Promise.all([applicationModules, previewModules])

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
const applicationStages = []
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
    startupObserver: (stage) => applicationStages.push(stage),
  })
  .then((value) => {
    startup.applicationStages = applicationStages
    startup.applicationReadyEpochMs = epochNow()
    return value
  })
const durable = await application
let startupPreview = previewRuntime.createStartupPreview({
  state: durable.app.state(),
  workspace: workspaceRoot,
  inline: true,
})
startup.previewReadyEpochMs = epochNow()

const terminalRuntime = await import(
  pathToFileURL(`${packageRoot}/dist/startup/terminal-runtime.js`).href
)
startup.terminalModulesReadyEpochMs = epochNow()

const controller = terminalRuntime.createApplicationUiController(durable.app, {
  color: 'none',
  reducedMotion: true,
})
startup.terminalReadyEpochMs = epochNow()

let started = false
let terminalApp
const stop = () => {
  if (started) terminalApp?.stop()
  else startupPreview?.close()
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
  const tui = startupPreview.tui
  terminalApp = new terminalRuntime.BraidTerminalApp({
    controller,
    tui,
    theme: terminalRuntime.createBraidTheme({ colors: false, reducedMotion: true }),
    workspace: workspaceRoot,
    nextOperationId: (() => {
      let next = 0
      return () => `op-perf-production-ui-${++next}`
    })(),
    tuiStarted: true,
  })
  const startupInput = startupPreview.adopt().input
  startupPreview = undefined
  started = true
  await terminalApp.start(startupInput)
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  if (started) terminalApp?.stop()
  else startupPreview?.close()
  await durable.app.close().catch(() => undefined)
}
