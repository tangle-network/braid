import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { createProductionConnectionAdapter } from '../src/adapters/connections/production-connections.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import {
  prepareProductionSelection,
  productionConnectionNeedsCredential,
  recoverPendingProductionCredential,
} from '../src/bin/production-setup-credentials.js'
import {
  loadProductionProfileCatalog,
  loadProductionSetup,
} from '../src/bin/production-setup-discovery.js'
import { saveProductionStartupSelection } from '../src/bin/production-setup-persistence.js'
import { credentialRef } from '../src/ports/credentials.js'
import type { HeadlessState } from '../src/views/shared/models.js'

const bridgeFetch: typeof fetch = async (input) => {
  const path = new URL(String(input)).pathname
  if (path.endsWith('/health')) {
    return new Response(
      JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }),
      { status: 200 },
    )
  }
  return new Response(
    JSON.stringify({ data: [{ id: 'pi/tangle-router/glm-5.2', backend: 'pi' }] }),
    { status: 200 },
  )
}

async function setupSelection(kind: 'tangle-inference' | 'tangle-sandbox') {
  const workspace = await mkdtemp(join(tmpdir(), 'braid-connection-setup-'))
  const setup = await loadProductionSetup({ workspace, fetch: bridgeFetch })
  const profile = setup.profiles[0]
  const connection = setup.connections.find((candidate) => candidate.kind === kind)
  assert.ok(profile)
  assert.ok(connection)
  return {
    workspace,
    setup,
    selection: {
      profile,
      connection,
      profileDigest: profile.digest,
      connectionDigest:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const,
    },
  }
}

test('first-run discovery offers CLI Bridge, Tangle inference, and Tangle sandbox', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'braid-connection-catalog-'))
  const setup = await loadProductionSetup({ workspace, fetch: bridgeFetch })
  assert.deepEqual(
    setup.connections.map((connection) => connection.kind),
    ['cli-bridge', 'tangle-inference', 'tangle-sandbox'],
  )
  assert.equal(setup.connections[1]?.endpoint, 'https://router.tangle.tools')
  assert.equal(setup.connections[2]?.endpoint, 'https://sandbox.tangle.tools')
  assert.equal(setup.connections[2]?.providerOptions.lifecycle, undefined)
  assert.equal(setup.connections[2]?.providerOptions.idleTtlSeconds, undefined)
  assert.equal(
    setup.connections.every((connection) => connection.credentialRef === undefined),
    true,
  )
})

test('regression: startup authentication never follows a workspace endpoint edit', async () => {
  const fixture = await setupSelection('tangle-inference')
  const bridge = fixture.setup.connections.find((connection) => connection.kind === 'cli-bridge')
  assert.ok(bridge)
  const edited = { ...bridge, endpoint: 'http://127.0.0.1:43918' }
  let requests = 0
  const fetcher: typeof fetch = async (input, init) => {
    requests++
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer startup-canary')
    return bridgeFetch(input, init)
  }
  const production = {
    profile: fixture.selection.profile.profile,
    connections: [edited],
    connectionId: edited.id,
  }
  await assert.rejects(
    loadProductionProfileCatalog(
      { workspace: fixture.workspace, bridgeAuth: 'startup-canary', fetch: fetcher },
      production,
      edited.id,
    ),
    { code: 'CONNECTION_CREDENTIAL_REAUTH_REQUIRED' },
  )
  assert.equal(requests, 0)
  await loadProductionProfileCatalog(
    {
      workspace: fixture.workspace,
      cliBridgeEndpoint: edited.endpoint,
      bridgeAuth: 'startup-canary',
      fetch: fetcher,
    },
    production,
    edited.id,
  )
  assert.equal(requests, 2)
  await assert.rejects(
    prepareProductionSelection(
      { workspace: fixture.workspace, tangleAuth: 'startup-canary' },
      {
        ...fixture.selection,
        connection: { ...fixture.selection.connection, endpoint: 'https://attacker.example' },
      },
      fixture.setup.configPath,
    ),
    { code: 'CONNECTION_CREDENTIAL_REAUTH_REQUIRED' },
  )
})

test('first-run discovery rejects remote HTTP before transmitting Bridge authentication', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'braid-remote-http-discovery-'))
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
  server.listen(0, '0.0.0.0')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    if (!address || typeof address === 'string') return
    await assert.rejects(
      loadProductionSetup({
        workspace,
        cliBridgeEndpoint: `http://0.0.0.0:${address.port}`,
        bridgeAuth: 'remote-http-secret-must-not-send',
      }),
      /rejects remote HTTP/iu,
    )
    assert.equal(requests, 0)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('remote CLI Bridge setup requires protected authentication before persistence', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'braid-remote-bridge-setup-'))
  const setup = await loadProductionSetup({ workspace, fetch: bridgeFetch })
  const profile = setup.profiles[0]
  const local = setup.connections.find((candidate) => candidate.kind === 'cli-bridge')
  assert.ok(profile)
  assert.ok(local)
  if (profile === undefined || local === undefined) throw new Error('setup catalog is incomplete')
  const remote = {
    ...local,
    name: 'Remote CLI Bridge',
    endpoint: 'https://remote-bridge.example.test',
    providerOptions: { ...local.providerOptions, transport: 'https' as const },
    lastHealth: { status: 'healthy' as const, checkedAt: '2026-08-09T00:00:00.000Z' },
  }
  const selection = {
    profile,
    connection: remote,
    profileDigest: profile.digest,
    connectionDigest:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const,
  }
  assert.equal(productionConnectionNeedsCredential({ workspace }, remote), true)
  await assert.rejects(
    prepareProductionSelection({ workspace }, selection, setup.configPath),
    /requires a credential/iu,
  )
  await assert.rejects(() => access(setup.configPath))

  const credentials = new MemoryCredentialStore()
  const secret = Buffer.from('remote-bridge-protected-secret')
  const requests: Array<string | null> = []
  const prepared = await prepareProductionSelection(
    { workspace, credentialStore: credentials },
    selection,
    setup.configPath,
    secret,
  )
  try {
    const resolver = prepared.startupOptions.credentialRefResolver
    assert.ok(resolver)
    if (resolver === undefined) throw new Error('protected credential resolver is missing')
    const adapter = createProductionConnectionAdapter(prepared.selection.connection, {
      credentials,
      credentialRefResolver: resolver,
      fetch: async (_input, init) => {
        requests.push(new Headers(init?.headers).get('authorization'))
        return new Response(
          JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }),
          { status: 200 },
        )
      },
    })
    assert.equal((await adapter.health()).status, 'healthy')
    assert.deepEqual(requests, ['Bearer remote-bridge-protected-secret'])
  } finally {
    await prepared.rollback()
    secret.fill(0)
  }
})

test('Tangle setup stores supplied bytes and persists every secret-free candidate', async () => {
  const { workspace, setup, selection } = await setupSelection('tangle-inference')
  const credentials = new MemoryCredentialStore()
  const secret = Buffer.from('tangle-setup-secret-canary', 'utf8')
  try {
    const prepared = await prepareProductionSelection(
      { workspace, credentialStore: credentials },
      selection,
      setup.configPath,
      secret,
    )
    const credentialId = prepared.selection.connection.credentialRef
    assert.match(credentialId ?? '', /^credential-tangle-inference-/u)
    assert.equal(secret.toString('utf8'), 'tangle-setup-secret-canary')
    assert.equal(prepared.startupOptions.bridgeAuth, undefined)
    assert.equal(prepared.startupOptions.tangleAuth, undefined)
    await saveProductionStartupSelection(setup.configPath, prepared.selection, {
      connections: setup.connections,
    })
    await prepared.commit()

    const document = JSON.parse(await readFile(setup.configPath, 'utf8')) as {
      readonly connectionId?: string
      readonly connections?: readonly {
        readonly id?: string
        readonly kind?: string
        readonly credentialRef?: string
      }[]
    }
    assert.equal(document.connectionId, selection.connection.id)
    assert.deepEqual(
      document.connections?.map((connection) => connection.kind),
      ['cli-bridge', 'tangle-inference', 'tangle-sandbox'],
    )
    assert.equal(
      document.connections?.find((connection) => connection.id === selection.connection.id)
        ?.credentialRef,
      credentialId,
    )
    assert.doesNotMatch(await readFile(setup.configPath, 'utf8'), /tangle-setup-secret-canary/u)
    assert.equal(credentials.has(credentialRef(`cred:v1:${credentialId ?? 'missing'}`)), true)
  } finally {
    secret.fill(0)
  }
})

test('Tangle setup fails before persistence when no credential source exists', async () => {
  const { workspace, setup, selection } = await setupSelection('tangle-sandbox')
  await assert.rejects(
    prepareProductionSelection({ workspace }, selection, setup.configPath),
    /requires a credential/iu,
  )
  await assert.rejects(() => access(setup.configPath))
})

test('generic pending credential recovery removes an interrupted Tangle secret', async () => {
  const { workspace, setup, selection } = await setupSelection('tangle-sandbox')
  const credentials = new MemoryCredentialStore()
  const secret = Buffer.from('interrupted-tangle-secret', 'utf8')
  try {
    const prepared = await prepareProductionSelection(
      { workspace, credentialStore: credentials },
      selection,
      setup.configPath,
      secret,
    )
    const credentialId = prepared.selection.connection.credentialRef
    assert.ok(credentialId)
    await access(`${setup.configPath}.pending-credential`)
    await recoverPendingProductionCredential(setup.configPath, { credentialStore: credentials })
    assert.equal(credentials.has(credentialRef(`cred:v1:${credentialId}`)), false)
    await assert.rejects(() => access(`${setup.configPath}.pending-credential`))
  } finally {
    secret.fill(0)
  }
})

// Real executable, encrypted restart, terminal input and HTTP Bridge protocol; no model is called.
test('startup prompt selects saved noncurrent history after setup and refuses bad IDs without a probe', {
  timeout: 60_000,
}, async () => {
  const { startRuntimeBridgeServer } = await import('./support/runtime-bridge-server.js')
  const bridge = await startRuntimeBridgeServer({
    advertisedModels: [{ id: 'pi/openai/gpt-5', backend: 'pi' }],
    responseText: 'SAVED_TARGET_REPLY',
  })
  const root = await mkdtemp(join(tmpdir(), 'braid-startup-target-'))
  const binary = fileURLToPath(new URL('../src/bin/braid.js', import.meta.url))
  const profile = defineAgentProfile({
    name: 'Saved target proof',
    harness: 'pi',
    model: { default: 'openai/gpt-5', provider: 'openai' },
  })
  try {
    for (const target of ['saved', 'missing', 'fuzzy'] as const) {
      const workspace = join(root, target)
      await mkdir(workspace)
      const config = join(workspace, 'config.json')
      const key = join(workspace, 'database.key')
      const profilePath = join(workspace, 'profile.json')
      const record = join(workspace, 'final.json')
      await writeFile(key, randomBytes(32), { mode: 0o600 })
      await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 })
      await writeFile(
        config,
        JSON.stringify({
          format: 'braid-startup-config',
          schemaVersion: 2,
          profile,
          connectionId: 'connection-seed',
          databaseKeyFile: key,
          connections: [
            {
              id: 'connection-seed',
              kind: 'cli-bridge',
              name: 'Loopback Bridge',
              endpoint: bridge.endpoint,
              providerOptions: { transport: 'local' },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              lastHealth: { status: 'unknown' },
            },
          ],
        }),
        { mode: 0o600 },
      )
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        BRAID_CLI_BRIDGE_ENDPOINT: bridge.endpoint,
        BRAID_STATE_PATH: join(workspace, 'state.sqlite'),
        XDG_CONFIG_HOME: join(workspace, 'config'),
        XDG_DATA_HOME: join(workspace, 'data'),
      }
      delete env.FORCE_COLOR
      const seed = spawn(
        process.execPath,
        [binary, 'rpc', '--workspace', workspace, '--config', config, '--database-key-file', key],
        { env, signal: AbortSignal.timeout(15_000), stdio: ['pipe', 'pipe', 'pipe'] },
      )
      let seedOutput = ''
      let seedError = ''
      seed.stdout.on('data', (chunk: Buffer) => {
        seedOutput += chunk.toString()
      })
      seed.stderr.on('data', (chunk: Buffer) => {
        seedError += chunk.toString()
      })
      const seeded = once(seed, 'close')
      seed.stdin.end(
        `${[
          { version: 1, requestId: 'init', command: 'initialize', params: { workspace } },
          {
            version: 1,
            requestId: 'target',
            operationId: 'op-create-target',
            command: 'new_conversation',
            params: { title: 'Saved target B' },
          },
          {
            version: 1,
            requestId: 'other',
            operationId: 'op-create-other',
            command: 'new_conversation',
            params: { title: 'Other A' },
          },
          { version: 1, requestId: 'state', command: 'get_state' },
          {
            version: 1,
            requestId: 'stop',
            operationId: 'op-seed-shutdown',
            command: 'shutdown',
            params: { mode: 'wait' },
          },
        ]
          .map((request) => JSON.stringify(request))
          .join('\n')}\n`,
      )
      assert.equal((await seeded)[0], 0, seedError)
      const seedReplies = seedOutput
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)) as Array<{
        type?: string
        requestId?: string
        state?: HeadlessState
      }>
      const seedState = seedReplies.find(
        (reply) => reply.type === 'state' && reply.requestId === 'state',
      )?.state
      assert.ok(seedState)
      const savedId = seedState.conversations.find(
        (conversation) => conversation.title === 'Saved target B',
      )?.id
      assert.ok(savedId)
      assert.notEqual(seedState.conversationId, savedId)
      await rm(config)
      const requested =
        target === 'saved' ? savedId : target === 'fuzzy' ? 'Saved' : 'conversation-missing'
      const prompt = `STARTUP_TARGET_${target}`
      const beforeRequests = bridge.requests.length
      const beforeSessions = bridge.sessions.length
      const emulator = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true })
      const child = pty.spawn(
        process.execPath,
        [
          binary,
          '--workspace',
          workspace,
          '--config',
          config,
          '--database-key-file',
          key,
          '--profile',
          profilePath,
          '--conversation',
          requested,
          '--prompt',
          prompt,
          '--record-state',
          record,
        ],
        { cwd: workspace, env, cols: 120, rows: 40 },
      )
      let output = ''
      const started = performance.now()
      const terminalEvents: unknown[] = []
      let exited = false
      const closed = new Promise<number>((resolve) =>
        child.onExit(({ exitCode }) => {
          exited = true
          resolve(exitCode)
        }),
      )
      child.onData((chunk) => {
        output += chunk
        terminalEvents.push([(performance.now() - started) / 1000, 'o', chunk])
        emulator.write(chunk)
      })
      const screen = () =>
        Array.from(
          { length: 40 },
          (_, row) =>
            emulator.buffer.active
              .getLine(emulator.buffer.active.viewportY + row)
              ?.translateToString(true) ?? '',
        ).join('\n')
      const waitFor = async (predicate: () => boolean) => {
        const deadline = Date.now() + 15_000
        while (!predicate()) {
          assert.ok(!exited && Date.now() < deadline, screen())
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      const watchdog = setTimeout(() => child.kill(), 20_000)
      try {
        await waitFor(() => screen().includes('choose an AgentProfile'))
        child.write('\r')
        await waitFor(() => screen().includes('choose a connection'))
        child.write('\r')
        await waitFor(() => screen().includes('review and start'))
        assert.equal(bridge.requests.length, beforeRequests, 'setup started a model/auth probe')
        child.write('\r')
        if (target === 'saved') {
          await waitFor(() => screen().includes('selection applied'))
          child.write('\r')
          await waitFor(
            () => screen().includes('SAVED_TARGET_REPLY') && screen().includes('new message'),
          )
          assert.equal(
            bridge.requests.length - beforeRequests,
            1,
            'initial prompt was not the only model request',
          )
        } else {
          await waitFor(() => screen().includes('Conversation not opened'))
          assert.equal(bridge.requests.length, beforeRequests, 'bad ID started a model/auth probe')
          assert.equal(bridge.sessions.length, beforeSessions, 'bad ID created a provider session')
          child.write('\u001b')
          await waitFor(() => !screen().includes('braid setup'))
        }
        child.write('\u0003')
        await waitFor(() => screen().toLowerCase().includes('ctrl+c again to quit'))
        child.write('\u0003')
        assert.equal(await closed, 0, output)
        const final = JSON.parse(await readFile(record, 'utf8')) as { state: HeadlessState }
        assert.equal(final.state.runs.length, target === 'saved' ? 1 : 0)
        if (target === 'saved') {
          assert.equal(final.state.conversationId, savedId)
          assert.equal(
            final.state.messages.filter(
              (message: { role: string; text: string }) =>
                message.role === 'user' && message.text === prompt,
            ).length,
            1,
          )
        }
        if (process.env.BRAID_RELEASE_ARTIFACT_ROOT !== undefined)
          await writeFile(
            join(process.env.BRAID_RELEASE_ARTIFACT_ROOT, `startup-target-${target}.cast`),
            [
              JSON.stringify({
                version: 2,
                width: 120,
                height: 40,
                title: `Public CLI setup ${target} target over controlled HTTP Bridge`,
                env: { TERM: 'xterm-256color' },
              }),
              ...terminalEvents.map((event) => JSON.stringify(event)),
              '',
            ].join('\n'),
            { mode: 0o600, flag: 'wx' },
          )
      } finally {
        clearTimeout(watchdog)
        if (!exited) child.kill()
        emulator.dispose()
      }
    }
  } finally {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})
