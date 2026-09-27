import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { createBraidApplication } from '../src/app/composition.js'
import { ConnectionActionService } from '../src/app/connection-actions.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import { createProfileRecord } from '../src/app/profiles.js'
import { withProductionConfigMutationLock } from '../src/bin/production-config-mutation-lock.js'
import { ProductionConnectionActions } from '../src/bin/production-connection-actions.js'
import {
  connectionSelection,
  withPersistedConnectionCatalog,
} from '../src/bin/production-connection-catalog.js'
import { saveProductionStartupSelection } from '../src/bin/production-setup-persistence.js'
import { loadProductionStartup } from '../src/bin/production-startup.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'

const at = '2026-09-27T00:00:00.000Z'
const profile = defineAgentProfile({
  name: 'Cloud setup proof',
  harness: 'pi',
  model: { default: 'openai/gpt-5', provider: 'openai' },
})
const source = createProfileRecord(
  {
    kind: 'inline',
    reference: 'braid:cloud-setup-proof',
    label: 'Cloud setup proof',
    writable: false,
    trusted: true,
  },
  profile,
)
const cloud: ConnectionRecord = {
  id: createConnectionId('connection-cloud-setup-proof'),
  kind: 'tangle-sandbox',
  name: 'Tangle Sandbox',
  endpoint: 'https://sandbox.tangle.tools',
  providerOptions: { transport: 'https' },
  createdAt: at,
  updatedAt: at,
  lastHealth: { status: 'unknown' },
}
const workspaceRequest = {
  repoUrl: 'https://github.com/tangle-network/braid.git',
  gitRef: 'main',
  cwd: { base: 'repository' as const, path: 'src' },
}

for (const request of [undefined, workspaceRequest]) {
  test(`connection metadata preserves ${request === undefined ? 'implicit ephemeral defaults' : 'the cloud workspace'} through disk reload`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'braid-cloud-setup-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { mode: 0o700 })
    const configPath = join(root, 'config.json')
    const app = createBraidApplication({ fixture: 'deterministic', profile })
    const catalog = new ConnectionRegistry([cloud])
    let requests = 0
    const fetcher: typeof fetch = async () => {
      requests += 1
      throw new Error('Metadata setup must not call a provider')
    }
    const startupOptions = { workspace, configPath, fetch: fetcher }
    try {
      app.initialize(workspace)
      await new ConnectionActionService({
        host: {
          state: () => app.state(),
          configuration: app.configuration,
          runtime: app.runtimeSelection,
        },
        connections: [cloud],
      }).select({ operationId: 'operation-initial-cloud', connectionId: cloud.id })
      await saveProductionStartupSelection(configPath, {
        profile: source,
        connection: cloud,
        profileDigest: source.digest,
        connectionDigest: catalog.select({ connectionId: cloud.id }).digest,
        ...(request === undefined ? {} : { workspaceRequest: request }),
      })
      const actions = new ProductionConnectionActions({
        currentApp: () => app,
        currentCatalog: () => catalog,
        configPath,
        startupOptions,
      })
      const updated = { ...cloud, name: 'Tangle next task', updatedAt: '2026-09-27T00:01:00.000Z' }
      await actions.upsert({ operationId: 'operation-edit-cloud-metadata', record: updated })
      const loaded = await loadProductionStartup(startupOptions)
      assert.deepEqual(loaded.workspaceRequest, request)
      assert.deepEqual(loaded.connections[0]?.providerOptions, cloud.providerOptions)
      assert.equal(loaded.connections[0]?.name, updated.name)
      assert.equal(app.state().runs.length, 0)
      assert.equal(requests, 0)

      const before = await readFile(configPath)
      await assert.rejects(
        withProductionConfigMutationLock(configPath, (mutationLock) =>
          withPersistedConnectionCatalog({
            configPath,
            mutationLock,
            startupOptions,
            selection: connectionSelection(app, { ...updated, name: 'Must roll back' }),
            connections: catalog.list(),
            action: async () => {
              throw new Error('Reproduced durable-action failure')
            },
          }),
        ),
        /Reproduced durable-action failure/u,
      )
      assert.deepEqual(await readFile(configPath), before)
      assert.deepEqual((await loadProductionStartup(startupOptions)).workspaceRequest, request)
      assert.equal(requests, 0)
    } finally {
      await app.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}
