import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { ConfigurationSession } from '../src/app/configuration-session.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import type { ProductionCompositionConfig } from '../src/app/production-composition.js'
import { createProfileRecord } from '../src/app/profiles.js'
import {
  activateProductionConnection,
  openProductionApplication,
  productionConfigForSelection,
} from '../src/bin/production-application.js'
import { prepareProductionSelection } from '../src/bin/production-setup-credentials.js'
import { tangleConnection } from '../src/bin/production-setup-discovery.js'
import { createProductionSetupEditor } from '../src/bin/production-setup-editor.js'
import { saveProductionStartupSelection } from '../src/bin/production-setup-persistence.js'
import type { ProductionApplicationSlot } from '../src/bin/production-setup-transition.js'
import {
  loadProductionStartup,
  type ProductionStartupLoadOptions,
} from '../src/bin/production-startup.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { FakeTangleRetainedSandbox } from './support/tangle-retained-sandbox.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })
const requested = {
  repoUrl: 'https://github.com/tangle-network/braid.git',
  gitRef: 'main',
  cwd: { base: 'repository' as const, path: 'src' },
}

function profile(name: string) {
  return createProfileRecord(
    { kind: 'inline', reference: `test:${name}`, label: name, writable: false, trusted: true },
    defineAgentProfile({
      name,
      harness: 'opencode',
      model: { default: 'openai/gpt-5', provider: 'openai' },
    }),
  )
}

async function waitFor(predicate: () => boolean, detail: () => string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Cloud setup proof timed out: ${detail()}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

for (const [columns, rows] of [[40, 12], [80, 24], [120, 40], [200, 60]] as const) {
  test(`cloud setup keyboard and durable user path ${columns}x${rows} (SDK double, not live Tangle)`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'braid-cloud-user-path-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { mode: 0o700 })
    const configPath = join(root, 'config.json')
    const statePath = join(root, 'braid.db')
    const sandbox = new FakeTangleRetainedSandbox()
    const profiles = [profile('Initial cloud profile'), profile('Next cloud profile')]
    const initialProfile = profiles[0]
    assert.ok(initialProfile)
    const connection = tangleConnection('tangle-sandbox', '2026-09-27T00:00:00.000Z')
    let httpRequests = 0
    const fetcher: typeof fetch = async () => {
      httpRequests += 1
      throw new Error('This proof must not call an external provider')
    }
    const prepared = await prepareProductionSelection(
      { workspace, configPath, credentialStore: new MemoryCredentialStore(), fetch: fetcher },
      {
        profile: initialProfile,
        connection,
        profileDigest: initialProfile.digest,
        connectionDigest: new ConnectionRegistry([connection]).select({ connectionId: connection.id }).digest,
      },
      configPath,
      new TextEncoder().encode('cloud-setup-secret-canary'),
    )
    await saveProductionStartupSelection(configPath, prepared.selection)
    await prepared.commit()
    const startupOptions = prepared.startupOptions
    const openApplication = (
      selectedOptions: ProductionStartupLoadOptions,
      production: ProductionCompositionConfig,
    ) => openProductionApplication({
      workspace,
      statePath,
      startupOptions: selectedOptions,
      production: {
        ...production,
        connectionOptions: { ...production.connectionOptions, sandboxClient: sandbox.client() },
      },
    })
    const active: ProductionApplicationSlot = {
      current: await openApplication(
        startupOptions,
        productionConfigForSelection(prepared.selection, startupOptions),
      ),
    }
    await activateProductionConnection(active.current.app, connection.id, [prepared.selection.connection])
    const controller = createApplicationUiController(active.current.app)
    const configuration = await createProductionSetupEditor({
      workspace,
      startupOptions,
      active,
      controller,
      profiles,
      currentCatalog: () => {
        assert.ok(active.current.connections)
        return active.current.connections
      },
      openApplication,
    })
    const terminal = new VirtualTerminal(columns, rows)
    const frames: Array<{ label: string; screen: string }> = []
    let operation = 0
    const view = new BraidTerminalApp({
      controller,
      tui: new TuiMainScreen(terminal),
      theme,
      workspace,
      configuration,
      nextOperationId: () => `operation-cloud-keyboard-${columns}-${++operation}`,
    })
    const done = view.start()
    const screen = () => terminal.getViewport().map((line) => line.trimEnd()).join('\n')
    const expectScreen = (pattern: RegExp) => waitFor(() => pattern.test(screen()), screen)
    const capture = (label: string) => {
      assert.doesNotMatch(screen(), /cloud-setup-secret-canary/u)
      frames.push({ label, screen: screen() })
    }
    const input = async (...keys: string[]) => {
      for (const key of keys) terminal.sendInput(key)
      await terminal.waitForRender()
    }
    try {
      await terminal.waitForRender()
      await input('/setup', '\r')
      await expectScreen(/choose an AgentProfile/u)
      capture('open from an already-configured terminal')
      await input('\u001b[B', '\r')
      await expectScreen(/choose a connection/u)
      await input('\r')
      await expectScreen(/workspace · cloud sandbox/u)
      assert.match(screen(), /files: ephemeral/u)
      await input(requested.repoUrl, '\r', requested.gitRef, '\r', requested.cwd.path, '\u000c')
      await expectScreen(/files · lifetime/u)
      await input('\u001b[B', '\r', '\u0015', '1800')
      capture('retained file lifetime before save')
      await input('\r')
      await expectScreen(/review and/u)
      capture('review is not execution')
      await input('\r')
      await expectScreen(/selection applied/u)
      capture('saved without execution')
      assert.equal(sandbox.createCalls.length, 0)
      assert.equal(sandbox.dispatches.length, 0)
      assert.equal(httpRequests, 0)
      assert.equal(active.current.app.state().runs.length, 0)
      const loaded = await loadProductionStartup(startupOptions)
      assert.deepEqual(loaded.workspaceRequest, requested)
      assert.equal(loaded.profile.name, 'Next cloud profile')
      const savedConnection = loaded.connections.find((record) => record.id === connection.id)
      assert.equal(savedConnection?.providerOptions.lifecycle, 'retained')
      assert.equal(savedConnection?.providerOptions.idleTtlSeconds, 1800)
      const savedBytes = await readFile(configPath)
      const savedApp = active.current.app
      await input('\u001b', '/setup', '\r')
      await expectScreen(/choose an AgentProfile/u)
      await input('\r', '\r')
      await expectScreen(/workspace · cloud sandbox/u)
      capture('reopened repository ref cwd and lifetime')
      assert.match(screen(), /main/u)
      assert.match(screen(), /src/u)
      await input('\u000c')
      await expectScreen(/files · lifetime/u)
      assert.match(screen(), /1800/u)
      await input('\u001b', '\u001b')
      await waitFor(() => view.editor.focused, screen)
      assert.equal(active.current.app, savedApp)
      assert.deepEqual(await readFile(configPath), savedBytes)
      assert.equal(sandbox.dispatches.length, 0)

      await input('CLOUD_SETUP_LATER_TASK', '\r')
      await waitFor(() => sandbox.dispatches.length === 1, () => JSON.stringify(controller.state()))
      const dispatch = sandbox.dispatches[0]
      assert.ok(dispatch)
      const run = active.current.app.state().runs.at(-1)
      assert.ok(run)
      assert.deepEqual(run.receipt.requested.workspaceRequest, requested)
      assert.equal(run.receipt.requested.profile.name, 'Next cloud profile')
      assert.equal(sandbox.createCalls[0]?.idleTimeoutSeconds, 1800)
      assert.equal(sandbox.createCalls[0]?.ephemeral, false)
      const admittedReceipt = structuredClone(run.receipt)
      assert.ok(configuration.current)
      const staged = new ConfigurationSession(configuration.current())
      staged.selectProfile(staged.state.selectedProfileId ?? '')
      staged.selectConnection(connection.id)
      staged.submitWorkspace({ ...requested, gitRef: 'not-admitted' })
      await assert.rejects(
        Promise.resolve().then(() => configuration.onCommit(staged.confirm())),
        /SETUP_RUN_UNSETTLED/u,
      )
      assert.equal(active.current.app, savedApp)
      assert.deepEqual(await readFile(configPath), savedBytes)
      assert.deepEqual(active.current.app.state().runs.at(-1)?.receipt, admittedReceipt)
      assert.equal(sandbox.cancellations.length, 0)
      sandbox.complete(dispatch.executionId, 'CLOUD_SETUP_LATER_TASK_OK')
      await active.current.app.waitForIdle()
      assert.equal(active.current.app.state().runs.at(-1)?.status, 'completed')
      capture('later explicit task completed through production admission')
      assert.equal(httpRequests, 0)
      t.diagnostic(JSON.stringify({
        proof: 'cloud-setup-production-keyboard',
        transport: 'existing FakeTangleRetainedSandbox SDK double; no live provider',
        columns, rows, creates: sandbox.createCalls.length, dispatches: sandbox.dispatches.length,
        requested: run.receipt.requested.workspaceRequest,
        receiptDigest: run.receipt.digest,
        frames,
      }))
    } finally {
      for (const dispatch of sandbox.dispatches) sandbox.complete(dispatch.executionId, 'cleanup')
      view.stop()
      await done
      await active.current.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}
