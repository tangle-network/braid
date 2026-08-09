import assert from 'node:assert/strict'
import { once } from 'node:events'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProductionConnectionAdapter } from '../src/adapters/connections/production-connections.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import {
  prepareProductionSelection,
  productionConnectionNeedsCredential,
  recoverPendingProductionCredential,
} from '../src/bin/production-setup-credentials.js'
import { loadProductionSetup } from '../src/bin/production-setup-discovery.js'
import { saveProductionStartupSelection } from '../src/bin/production-setup-persistence.js'
import { credentialRef } from '../src/ports/credentials.js'

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
  assert.equal(
    setup.connections.every((connection) => connection.credentialRef === undefined),
    true,
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
