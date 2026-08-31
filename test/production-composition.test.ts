import assert from 'node:assert/strict'
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import {
  type AgentProfile,
  canonicalAgentProfileDigest,
  canonicalCandidateJson,
  defineAgentProfile,
} from '@tangle-network/agent-interface'
import {
  materializeBridgeModelRoute,
  portableBridgeModel,
  qualifyBridgeProfileModel,
} from '../src/adapters/connections/cli-bridge-model-route.js'
import { HeadlessCredentialStore } from '../src/adapters/credentials/headless-store.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { resolveProductionCliBridgeConnection } from '../src/adapters/runtime/production-backend-resolver.js'
import { ApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import {
  createBraidApplication,
  createDurableBraidApplication,
  createProductionBraidApplication,
} from '../src/app/composition.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import { MemoryJournal } from '../src/app/journal.js'
import {
  createProductionComposition,
  type ProductionCompositionConfig,
  ProductionCompositionError,
} from '../src/app/production-composition.js'
import { createProfileRecord } from '../src/app/profiles.js'
import { parseArgs } from '../src/bin/args.js'
import {
  openProductionApplication,
  productionConfigForSelection,
} from '../src/bin/production-application.js'
import { discoverBridge } from '../src/bin/production-bridge-discovery.js'
import { createProductionCredentialContext } from '../src/bin/production-credential-context.js'
import {
  DEFAULT_CLI_BRIDGE_ENDPOINT,
  describeProductionSelection,
  loadProductionProfileCatalog,
  loadProductionSetup,
  persistableProductionProfile,
  prepareProductionSelection,
  recoverPendingProductionCredential,
  saveProductionStartupSelection,
  transitionProductionSelection,
  validateProductionSelection,
} from '../src/bin/production-setup.js'
import {
  formatProductionStartupError,
  loadProductionStartup,
  ProductionStartupError,
} from '../src/bin/production-startup.js'
import { defaultBraidDataDirectory, defaultStatePath } from '../src/bin/state-path.js'
import type { ConnectionKind, ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createCredentialRefId } from '../src/domain/ids.js'
import { FixedClock } from '../src/ports/clock.js'
import { credentialRef } from '../src/ports/credentials.js'
import { SequenceIds } from '../src/ports/ids.js'
import {
  bridgeCapabilityDocument,
  startRuntimeBridgeServer,
} from './support/runtime-bridge-server.js'
import { FakeTangleRetainedSandbox } from './support/tangle-retained-sandbox.js'

const at = '2026-08-03T12:00:00.000Z'

function profile(): Readonly<AgentProfile> {
  return defineAgentProfile({
    name: 'production test profile',
    description: 'A canonical profile used by the production composition proof',
    harness: 'pi',
    model: { default: 'openai/gpt-5', provider: 'openai' },
  })
}

function connection(
  kind: ConnectionKind,
  id: string,
  endpoint: string,
  withCredential = false,
): ConnectionRecord {
  return {
    id: createConnectionId(`connection-${id}`),
    kind,
    name: `${kind} ${id}`,
    endpoint,
    ...(withCredential ? { credentialRef: createCredentialRefId(`credential-${id}`) } : {}),
    providerOptions: { transport: kind === 'cli-bridge' ? 'local' : 'https' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the production provider')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

async function transitionSetup(root: string) {
  const setup = await loadProductionSetup({
    workspace: root,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/health') {
        return new Response(
          JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'pi/openai-codex/gpt-5.6-luna', backend: 'pi' }] }),
        { status: 200 },
      )
    },
  })
  const selectedProfile = setup.profiles[0]
  const selectedConnection = setup.connections[0]
  if (!selectedProfile || !selectedConnection) throw new Error('transition test setup is empty')
  return {
    setup,
    selection: {
      profile: selectedProfile,
      connection: selectedConnection,
      profileDigest: selectedProfile.digest,
      connectionDigest:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const,
    },
  }
}

function composition(
  record: ConnectionRecord,
  options: ProductionCompositionConfig['connectionOptions'] = {},
  selectedProfile: Readonly<AgentProfile> = profile(),
): ProductionCompositionConfig {
  return {
    profile: selectedProfile,
    connections: [record],
    connectionId: record.id,
    connectionOptions: options,
  }
}

async function runProductionTurn(config: ProductionCompositionConfig): Promise<{
  readonly url: string
  readonly state: ReturnType<ReturnType<typeof createBraidApplication>['state']>
}> {
  const clock = new FixedClock()
  const journal = new MemoryJournal(clock)
  const app = createBraidApplication({
    production: config,
    clock,
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  try {
    app.initialize('/workspace')
    const receipt = app.send({ operationId: 'op-production-turn', text: 'run production' })
    await receipt.admissionReady
    const state = await receipt.completion
    return { url: config.connections[0]?.endpoint ?? '', state }
  } finally {
    await app.close()
  }
}

test('normal composition streams a configured CLI Bridge turn through agent-runtime', async () => {
  const bridge = await startRuntimeBridgeServer()
  try {
    const record = connection('cli-bridge', 'local', bridge.endpoint)
    const result = await runProductionTurn(composition(record))

    assert.equal(
      result.state.runs[0]?.status,
      'completed',
      JSON.stringify({ run: result.state.runs[0], requests: bridge.requests }),
    )
    assert.equal(result.state.messages.at(-1)?.text, 'production response')
    assert.equal(bridge.requests.length, 1)
    assert.equal(bridge.requests[0]?.session?.model, 'pi/openai/gpt-5')
    assert.equal(result.state.runs[0]?.receipt.provider, 'cli-bridge')
    assert.equal(result.state.environments.length, 1)
    assert.equal(result.state.environments[0]?.kind, 'local-process')
    assert.equal(result.state.environments[0]?.placement.provider, 'cli-bridge')
    assert.equal(result.state.environments[0]?.continuity, 'session')
    assert.equal(result.state.runs[0]?.environmentId, result.state.environments[0]?.id)
  } finally {
    await bridge.close()
  }
})

test('retained CLI Bridge turns forward request-scoped model credentials only on the model call', async () => {
  const bridge = await startRuntimeBridgeServer()
  const seen: { token?: string | null; baseUrl?: string | null } = {}
  try {
    const record = connection('cli-bridge', 'scoped-model', bridge.endpoint)
    const result = await runProductionTurn(
      composition(record, {
        bridgeModelCredential: {
          key: 'BRAID_TEST_MODEL_TOKEN',
          baseUrlKey: 'BRAID_TEST_MODEL_BASE_URL',
          provider: {
            get: async (key: string) =>
              key === 'BRAID_TEST_MODEL_TOKEN'
                ? 'test-model-token'
                : key === 'BRAID_TEST_MODEL_BASE_URL'
                  ? 'https://chatgpt.com/backend-api'
                  : undefined,
          },
        },
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname
          if (path === '/v1/chat/completions' || /^\/v1\/sessions\/[^/]+\/turns$/u.test(path)) {
            seen.token = requestHeader(init, 'x-cli-bridge-model-credential')
            seen.baseUrl = requestHeader(init, 'x-cli-bridge-model-base-url')
          }
          return fetch(input, init)
        },
      }),
    )

    assert.equal(result.state.runs[0]?.status, 'completed')
    assert.equal(seen.token, 'test-model-token')
    assert.equal(seen.baseUrl, 'https://chatgpt.com/backend-api')
  } finally {
    await bridge.close()
  }
})

test('production composition persists acknowledged CLI Bridge cancellation', async () => {
  const bridge = await startRuntimeBridgeServer({ holdStreams: true })
  const clock = new FixedClock()
  const journal = new MemoryJournal(clock)
  const record = connection('cli-bridge', 'cancel', bridge.endpoint)
  const app = createBraidApplication({
    production: composition(record),
    clock,
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 1_000,
  })
  try {
    app.initialize('/workspace')
    const send = app.send({ operationId: 'op-production-cancel', text: 'cancel production' })
    await send.admissionReady
    await waitForCondition(() => app.state().runs[0]?.controlRef !== undefined, 5_000)

    const cancellation = app.cancel({
      operationId: 'op-production-cancel-request',
      runId: send.runId,
      reason: 'operator requested cancellation',
    })
    const state = await cancellation.completion
    assert.equal(
      state.runs[0]?.status,
      'aborted',
      JSON.stringify({
        run: state.runs[0],
        events: app.events(),
        cancellations: bridge.cancellations,
      }),
    )
    assert.equal(state.runs[0]?.terminalReason, 'CONTROL_DETAIL')
    assert.equal(state.lastError, null)
    assert.equal(bridge.cancellations.length, 1)
  } finally {
    await app.close()
    await bridge.close()
  }
})

test('normal composition streams a configured Tangle inference turn through agent-runtime', async () => {
  const record = connection('tangle-inference', 'cloud', 'https://router.test', true)
  const credentials = new MemoryCredentialStore()
  const ref = credentialRef('cred:v1:credential-cloud')
  await credentials.store({ ref, value: Buffer.from('test-only-provider-secret') })
  const calls: Array<Record<string, unknown>> = []
  const result = await runProductionTurn(
    composition(
      record,
      {
        credentials,
        credentialRefResolver: () => ref,
        routerComplete: async (body) => {
          calls.push(body)
          return {
            model: 'openai/gpt-5',
            choices: [{ message: { content: 'production response' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 3 },
          }
        },
      },
      defineAgentProfile({
        name: 'direct inference profile',
        harness: 'cli-base',
        model: { default: 'openai/gpt-5', provider: 'openai' },
      }),
    ),
  )

  assert.equal(
    result.state.runs[0]?.status,
    'completed',
    JSON.stringify({ run: result.state.runs[0], url: result.url }),
  )
  assert.equal(
    result.state.messages.at(-1)?.text,
    'production response',
    JSON.stringify({ state: result.state, url: result.url }),
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.model, 'openai/gpt-5')
  assert.equal(result.state.environments.length, 1)
  assert.equal(result.state.environments[0]?.kind, 'remote-service')
  assert.equal(result.state.environments[0]?.placement.provider, 'tangle-inference')
  assert.equal(result.state.environments[0]?.lifecycleMode, 'request')
})

test('durable composition uses the configured backend on the normal startup path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-durable-'))
  const bridge = await startRuntimeBridgeServer()
  try {
    const record = connection('cli-bridge', 'durable', bridge.endpoint)
    const { app } = await createDurableBraidApplication({
      path: join(root, 'braid.db'),
      workspaceRoot: root,
      credentialStore: new MemoryCredentialStore(),
      production: composition(record),
    })
    try {
      app.initialize(root)
      await app.whenDurable()
      const state = await app.send({
        operationId: 'op-durable-production-turn',
        text: 'run durable production',
      }).completion
      assert.equal(state.runs[0]?.status, 'completed')
      assert.equal(state.runs[0]?.receipt.provider, 'cli-bridge')
      assert.equal(state.messages.at(-1)?.text, 'production response')
      assert.equal(bridge.requests.length, 1)
    } finally {
      await app.close()
    }
  } finally {
    await bridge.close()
  }
})

test('strict production composition fails closed when configuration is missing', () => {
  assert.throws(
    () => createProductionBraidApplication(),
    (error: unknown) =>
      error instanceof ProductionCompositionError &&
      error.code === 'PRODUCTION_CONFIGURATION_REQUIRED' &&
      /canonical profile.*configured connection/iu.test(error.message),
  )
  assert.throws(
    () =>
      createProductionBraidApplication({
        production: {
          profile: profile(),
          connections: [],
          connectionId: 'connection-missing',
        },
      }),
    (error: unknown) =>
      error instanceof ProductionCompositionError &&
      error.code === 'PRODUCTION_CONNECTION_REQUIRED',
  )
})

test('strict production composition rejects unsupported connection kinds', () => {
  const unsupported = {
    ...connection('cli-bridge', 'unsupported', 'http://127.0.0.1:4010'),
    kind: 'unsupported-provider',
  } as unknown as ConnectionRecord

  assert.throws(
    () =>
      createProductionBraidApplication({
        production: {
          profile: profile(),
          connections: [unsupported],
          connectionId: unsupported.id,
        },
      }),
    (error: unknown) =>
      error instanceof ProductionCompositionError &&
      error.code === 'PRODUCTION_CONNECTION_UNSUPPORTED' &&
      /unsupported provider kind/iu.test(error.message),
  )
})

test('production rejects remote cleartext endpoints unless an explicit policy accepts them', () => {
  const remote = connection('cli-bridge', 'remote-cleartext', 'http://bridge.example.test')
  assert.throws(
    () => createProductionComposition(composition(remote)),
    (error: unknown) =>
      error instanceof ProductionCompositionError && error.code === 'PRODUCTION_CONNECTION_INVALID',
  )

  const accepted = createProductionComposition(
    composition(remote, {
      trustedTransportPolicy: ({ record, endpoint }) =>
        record.id === remote.id && endpoint === remote.endpoint,
    }),
  )
  assert.equal(accepted.connection.id, remote.id)
})

test('retained Tangle composition exposes one native control through durable startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-native-control-'))
  const record: ConnectionRecord = {
    ...connection('tangle-sandbox', 'native-control', 'https://sandbox.tangle.tools'),
    providerOptions: {
      transport: 'https',
      lifecycle: 'retained',
      idleTtlSeconds: 1_800,
    },
  }
  const selected = composition(
    record,
    {},
    defineAgentProfile({
      name: 'native production profile',
      harness: 'opencode',
      model: { default: 'openai/gpt-5', provider: 'openai' },
    }),
  )
  const composed = createProductionComposition(selected)
  assert.notEqual(composed.nativeInteractive, undefined)
  assert.notEqual(composed.supervisorController, undefined)

  const durable = await createDurableBraidApplication({
    path: join(root, 'braid.db'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    production: selected,
  })
  try {
    assert.notEqual(durable.nativeInteractive, undefined)
  } finally {
    await durable.app.close()
    await durable.storage.close()
  }
})

test('retained Tangle composition routes interactive admission without creating a sandbox', async () => {
  const sandbox = new FakeTangleRetainedSandbox()
  const record: ConnectionRecord = {
    ...connection('tangle-sandbox', 'interactive-routing', 'https://sandbox.tangle.tools', true),
    providerOptions: {
      transport: 'https',
      lifecycle: 'retained',
      idleTtlSeconds: 1_800,
    },
  }
  const credentials = new MemoryCredentialStore()
  await credentials.store({
    ref: credentialRef('cred:v1:credential-interactive-routing'),
    value: Buffer.from('test-only-sandbox-key'),
  })
  const selectedProfile = defineAgentProfile({
    name: 'interactive routing profile',
    harness: 'opencode',
    model: { default: 'openai/gpt-5', provider: 'openai' },
  })
  const composed = createProductionComposition(
    composition(record, { credentials, sandboxClient: sandbox.client() }, selectedProfile),
  )
  const interactiveTurn = {
    operationId: 'operation-interactive-routing',
    runId: 'run-interactive-routing',
    text: 'Inspect this workspace.',
    profile: selectedProfile,
    connectionId: record.id,
    signal: new AbortController().signal,
  }
  const interactive = await composed.execution.admit?.({
    ...interactiveTurn,
    mode: 'interactive',
  })
  assert.equal(interactive?.provider, 'tangle-sandbox')
  assert.equal(
    interactive?.providerSessionId,
    undefined,
    'interactive admission must leave session identity to agent-runtime',
  )
  assert.equal(interactive?.materializationReceipt?.surface, 'interactive-agent')
  assert.equal(interactive?.capabilities?.environment?.interactiveAgent?.start, true)
  assert.equal(sandbox.createCalls.length, 0)
  const headless = await composed.execution.admit?.({
    ...interactiveTurn,
    operationId: 'operation-headless-routing',
    runId: 'run-headless-routing',
  })
  assert.equal(headless?.materializationReceipt?.surface, undefined)
  assert.equal(headless?.capabilities?.streaming.replay, true)
  assert.equal(sandbox.createCalls.length, 0)
})

test('bin startup loads a canonical profile and exact connection from a bounded config file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-startup-'))
  const profilePath = join(root, 'profile.json')
  const configPath = join(root, 'config.json')
  const record = connection('cli-bridge', 'config', 'http://127.0.0.1:4010', true)
  await writeFile(profilePath, `${canonicalCandidateJson(profile())}\n`, { mode: 0o600 })
  await writeFile(
    configPath,
    `${JSON.stringify({
      format: 'braid-startup-config',
      schemaVersion: 1,
      profile: 'profile.json',
      connectionId: record.id,
      connections: [record],
    })}\n`,
    { mode: 0o600 },
  )

  const credentials = new MemoryCredentialStore()
  const startup = await loadProductionStartup({
    workspace: root,
    configPath,
    credentialStore: credentials,
  })
  assert.equal(startup.profile.name, 'production test profile')
  assert.equal(startup.connectionId, record.id)
  assert.equal(startup.connectionOptions?.credentials, credentials)
  assert.equal(
    await startup.connectionOptions?.credentialRefResolver?.(
      createCredentialRefId('credential-config'),
    ),
    'cred:v1:credential-config',
  )
  assert.equal(parseArgs(['--config', configPath], root).config, configPath)
})

test('startup persists the workspace request, reloads it, and preserves legacy absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-workspace-request-'))
  const configPath = join(root, '.braid', 'config.json')
  const profileRecord = createProfileRecord(
    {
      kind: 'inline',
      reference: 'test:workspace-request',
      label: 'workspace request profile',
      writable: false,
      trusted: true,
    },
    profile(),
  )
  const sandbox = connection('tangle-sandbox', 'workspace-request', 'https://sandbox.test')
  const selection = {
    profile: profileRecord,
    connection: sandbox,
    profileDigest: profileRecord.digest,
    connectionDigest:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const,
    workspaceRequest: {
      repoUrl: 'https://github.com/acme/repository',
      gitRef: 'main',
      cwd: { base: 'repository' as const, path: 'src' },
      providerOptions: {},
    },
  }
  await saveProductionStartupSelection(configPath, selection)
  const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
    [key: string]: unknown
    workspaceRequest?: Record<string, unknown>
  }
  assert.deepEqual(saved.workspaceRequest, {
    repoUrl: 'https://github.com/acme/repository',
    gitRef: 'main',
    cwd: { base: 'repository', path: 'src' },
  })
  assert.ok(saved.workspaceRequest)
  assert.equal('providerOptions' in saved.workspaceRequest, false)

  const restarted = await loadProductionStartup({ workspace: root })
  assert.deepEqual(restarted.workspaceRequest, saved.workspaceRequest)
  assert.equal(Object.isFrozen(restarted.workspaceRequest), true)

  const legacy = { ...saved, schemaVersion: 1 }
  delete legacy.workspaceRequest
  await writeFile(configPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 })
  const legacyStartup = await loadProductionStartup({ workspace: root })
  assert.equal(legacyStartup.workspaceRequest, undefined)

  await writeFile(
    configPath,
    `${JSON.stringify({ ...legacy, schemaVersion: 2, workspaceRequest: { gitRef: 'main' } })}\n`,
    { mode: 0o600 },
  )
  await assert.rejects(
    () => loadProductionStartup({ workspace: root }),
    (error: unknown) =>
      error instanceof ProductionStartupError &&
      error.code === 'PRODUCTION_CONFIGURATION_INVALID' &&
      /gitRef requires repoUrl/iu.test(String(error.cause)),
  )
})

test('CLI routing overrides agree with the canonical profile passed to runtime', async () => {
  const cases = [
    {
      name: 'model only',
      options: { model: 'openai/gpt-5.1' },
      runner: 'pi' as const,
      model: 'openai/gpt-5.1',
      route: 'pi/openai/gpt-5.1',
    },
    {
      name: 'runner only',
      options: { runner: 'codex' },
      runner: 'codex' as const,
      model: 'openai/gpt-5',
      route: 'codex/openai/gpt-5',
    },
    {
      name: 'model and runner',
      options: { model: 'openai/gpt-5.1', runner: 'codex' },
      runner: 'codex' as const,
      model: 'openai/gpt-5.1',
      route: 'codex/openai/gpt-5.1',
    },
    {
      name: 'no override',
      options: {},
      runner: 'pi' as const,
      model: 'openai/gpt-5',
      route: 'pi/openai/gpt-5',
    },
  ] as const

  const bridge = await startRuntimeBridgeServer()
  try {
    for (const candidate of cases) {
      const root = await mkdtemp(join(tmpdir(), `braid-production-routing-${candidate.name}-`))
      const configPath = join(root, 'config.json')
      const record = connection(
        'cli-bridge',
        `routing-${candidate.name.replaceAll(' ', '-')}`,
        bridge.endpoint,
      )
      await writeFile(
        configPath,
        `${JSON.stringify({
          format: 'braid-startup-config',
          schemaVersion: 2,
          profile: profile(),
          connectionId: record.id,
          connections: [record],
        })}\n`,
        { mode: 0o600 },
      )

      const startup = await loadProductionStartup({
        workspace: root,
        configPath,
        ...candidate.options,
      })
      assert.equal(startup.profile.name, 'production test profile', candidate.name)
      assert.equal(startup.profile.harness, candidate.runner, candidate.name)
      assert.equal(startup.profile.model?.default, candidate.model, candidate.name)
      assert.equal(startup.profile.model?.provider, 'openai', candidate.name)

      const composition = createProductionComposition({
        ...startup,
        workspaceRoot: root,
      })
      // CLI Bridge routing is proved on the retained port, which owns Bridge execution.
      const admission = await composition.execution.admit?.({
        operationId: `operation-routing-${candidate.name}`,
        runId: `run-routing-${candidate.name}`,
        text: 'verify routing override',
        profile: composition.profile,
        workspaceRoot: root,
        signal: new AbortController().signal,
      })
      assert.equal(admission?.materializationReceipt?.runner, candidate.runner, candidate.name)
      assert.equal(admission?.materializationReceipt?.model, candidate.model, candidate.name)
      assert.equal(admission?.materializationReceipt?.route, candidate.route, candidate.name)
    }
  } finally {
    await bridge.close()
  }
})

test('CLI Bridge routes preserve nested model ids below the selected provider', () => {
  const model = 'openai/gpt-5.6-luna'
  const qualified = 'tangle-router/openai/gpt-5.6-luna'
  const routed = `pi/${qualified}`

  assert.equal(qualifyBridgeProfileModel(model, 'tangle-router'), qualified)
  assert.equal(qualifyBridgeProfileModel(qualified, 'tangle-router'), qualified)
  assert.equal(portableBridgeModel('pi', routed, 'tangle-router'), qualified)
  assert.equal(materializeBridgeModelRoute('pi', model, 'tangle-router'), routed)
  assert.equal(materializeBridgeModelRoute('codex', 'codex/default', 'codex'), 'codex/default')
})

test('schema-v1 CLI Bridge profiles load as portable models and dispatch one runner prefix', async () => {
  const cases = [
    {
      runner: 'pi' as const,
      routed: 'pi/tangle-router/glm-5.2',
      portable: 'tangle-router/glm-5.2',
    },
    { runner: 'codex' as const, routed: 'codex/default', portable: 'codex/default' },
  ]
  const bridge = await startRuntimeBridgeServer()
  try {
    for (const candidate of cases) {
      const root = await mkdtemp(join(tmpdir(), `braid-production-v1-${candidate.runner}-`))
      const configPath = join(root, 'config.json')
      const record = connection('cli-bridge', `v1-${candidate.runner}`, bridge.endpoint)
      await writeFile(
        configPath,
        `${JSON.stringify({
          format: 'braid-startup-config',
          schemaVersion: 1,
          profile: {
            name: `prior ${candidate.runner} profile`,
            harness: candidate.runner,
            model: {
              default: candidate.routed,
              provider: candidate.runner === 'pi' ? 'tangle-router' : 'codex',
            },
          },
          connectionId: record.id,
          connections: [record],
        })}\n`,
        { mode: 0o600 },
      )

      const startup = await loadProductionStartup({ workspace: root, configPath })
      assert.equal(startup.profile.model?.default, candidate.portable)
      const prepared = await resolveProductionCliBridgeConnection(
        {
          connections: new ConnectionRegistry([record]),
          workspaceCwd: root,
          select: () => ({ connection: { connectionId: record.id } }),
        },
        {
          operationId: `operation-v1-${candidate.runner}`,
          runId: `run-v1-${candidate.runner}`,
          text: 'verify prior profile',
          profile: startup.profile,
          signal: new AbortController().signal,
        },
      )
      assert.equal(prepared.profile.model?.default, candidate.portable)
      assert.equal(prepared.materializationReceipt.route, candidate.routed)
    }
  } finally {
    await bridge.close()
  }
})

test('runner-only CLI Bridge models execute without an invented provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-runner-model-'))
  const bridge = await startRuntimeBridgeServer()
  const record = connection('cli-bridge', 'runner-model', bridge.endpoint)
  const runnerProfile = defineAgentProfile({
    name: 'Claude runner alias',
    harness: 'claude-code',
    model: { default: 'opus', reasoningEffort: 'high' },
  })
  try {
    const prepared = await resolveProductionCliBridgeConnection(
      {
        connections: new ConnectionRegistry([record]),
        workspaceCwd: root,
        select: () => ({ connection: { connectionId: record.id } }),
      },
      {
        operationId: 'operation-runner-model',
        runId: 'run-runner-model',
        text: 'verify runner alias',
        profile: runnerProfile,
        signal: new AbortController().signal,
      },
    )

    assert.equal(prepared.profile.model?.default, 'opus')
    assert.equal(prepared.profile.model?.provider, undefined)
    assert.equal(prepared.materializationReceipt.route, 'claude-code/opus')
  } finally {
    await bridge.close()
  }
})

test('startup resolves relative database keys beside external config and rejects workspace paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'braid-production-key-workspace-'))
  const configDirectory = await mkdtemp(join(tmpdir(), 'braid-production-key-config-'))
  const configPath = join(configDirectory, 'config.json')
  const keyPath = join(configDirectory, 'database.key')
  const profilePath = join(configDirectory, 'profile.json')
  const record = connection('cli-bridge', 'relative-key', 'http://127.0.0.1:3344')
  await writeFile(profilePath, `${canonicalCandidateJson(profile())}\n`, { mode: 0o600 })
  await writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 })
  await chmod(keyPath, 0o600)
  await writeFile(
    configPath,
    `${JSON.stringify({
      format: 'braid-startup-config',
      schemaVersion: 1,
      profile: 'profile.json',
      connectionId: record.id,
      connections: [record],
      databaseKeyFile: 'database.key',
    })}\n`,
    { mode: 0o600 },
  )

  const startup = await loadProductionStartup({ workspace, configPath })
  assert.equal(startup.databaseKeyFile, keyPath)
  assert.equal(relative(workspace, startup.databaseKeyFile ?? ''), relative(workspace, keyPath))

  const workspaceKeyPath = join(workspace, 'database.key')
  await writeFile(workspaceKeyPath, Buffer.alloc(32, 8), { mode: 0o600 })
  await chmod(workspaceKeyPath, 0o600)
  await writeFile(
    configPath,
    `${JSON.stringify({
      format: 'braid-startup-config',
      schemaVersion: 1,
      profile: 'profile.json',
      connectionId: record.id,
      connections: [record],
      databaseKeyFile: relative(configDirectory, workspaceKeyPath),
    })}\n`,
    { mode: 0o600 },
  )
  await assert.rejects(
    () => loadProductionStartup({ workspace, configPath }),
    (error: unknown) =>
      error instanceof ProductionStartupError &&
      error.code === 'PRODUCTION_DATABASE_KEY_INVALID' &&
      /outside the agent workspace|protected mode-0600/iu.test(formatProductionStartupError(error)),
  )
})

test('production default state isolates workspaces and config identities across restart', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'braid-production-state-data-'))
  const keyDirectory = await mkdtemp(join(tmpdir(), 'braid-production-state-keys-'))
  const workspaceA = await mkdtemp(join(tmpdir(), 'braid-production-state-a-'))
  const workspaceB = await mkdtemp(join(tmpdir(), 'braid-production-state-b-'))
  const configPathA = join(workspaceA, '.braid', 'config.json')
  const configPathB = join(workspaceB, '.braid', 'config.json')
  const keyPathA = join(keyDirectory, 'workspace-a.key')
  const keyPathB = join(keyDirectory, 'workspace-b.key')
  await mkdir(join(workspaceA, '.braid'), { recursive: true, mode: 0o700 })
  await mkdir(join(workspaceB, '.braid'), { recursive: true, mode: 0o700 })
  await writeFile(configPathA, '{"identity":"workspace-a"}\n', { mode: 0o600 })
  await writeFile(configPathB, '{"identity":"workspace-b"}\n', { mode: 0o600 })
  await writeFile(keyPathA, Buffer.alloc(32, 41), { mode: 0o600 })
  await writeFile(keyPathB, Buffer.alloc(32, 42), { mode: 0o600 })
  await chmod(keyPathA, 0o600)
  await chmod(keyPathB, 0o600)

  const environment = { XDG_DATA_HOME: dataDirectory }
  const statePathA = defaultStatePath(workspaceA, configPathA, environment)
  const statePathB = defaultStatePath(workspaceB, configPathB, environment)
  assert.notEqual(statePathA, statePathB)
  assert.match(
    relative(join(dataDirectory, 'braid', 'workspaces'), statePathA),
    /^[0-9a-f]{64}\/braid\.sqlite$/u,
  )
  assert.notEqual(
    defaultStatePath(workspaceA, join(workspaceA, '.braid', 'alternate.json'), environment),
    statePathA,
  )
  assert.equal(
    defaultStatePath(workspaceA, configPathA, {
      ...environment,
      BRAID_STATE_PATH: join(dataDirectory, 'explicit.sqlite'),
    }),
    join(dataDirectory, 'explicit.sqlite'),
  )
  assert.ok(relative(workspaceA, statePathA).startsWith('..'))
  assert.ok(relative(workspaceB, statePathB).startsWith('..'))
  assert.equal(defaultBraidDataDirectory(environment), join(dataDirectory, 'braid'))

  const openAndClose = async (
    workspace: string,
    configPath: string,
    keyPath: string,
    statePath: string,
    id: string,
  ): Promise<void> => {
    const context = createProductionCredentialContext({
      workspace,
      configPath,
      databaseKeyFile: keyPath,
      dataDirectory,
    })
    assert.ok(context)
    if (!context) return
    const record = connection('cli-bridge', id, 'http://127.0.0.1:3344')
    const fetcher: typeof fetch = async () => new Response('{}', { status: 200 })
    const handle = await openProductionApplication({
      workspace,
      statePath,
      startupOptions: {
        workspace,
        configPath,
        databaseKeyFile: context.databaseKeyFile,
        credentialStore: context.store,
        credentialContext: context,
        fetch: fetcher,
      },
      production: {
        profile: profile(),
        connections: [record],
        connectionId: record.id,
        databaseKeyFile: context.databaseKeyFile,
        connectionOptions: { credentials: context.store, fetch: fetcher },
      },
    })
    try {
      assert.equal(handle.app.state().workspace, workspace)
    } finally {
      await handle.close()
    }
    await access(statePath)
  }

  await openAndClose(workspaceA, configPathA, keyPathA, statePathA, 'restart-a-1')
  await openAndClose(workspaceB, configPathB, keyPathB, statePathB, 'restart-b-1')
  await openAndClose(workspaceA, configPathA, keyPathA, statePathA, 'restart-a-2')
  await openAndClose(workspaceB, configPathB, keyPathB, statePathB, 'restart-b-2')
})

test('first-run setup exposes secret-free candidates and writes a recoverable config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-setup-'))
  const discoveryPaths: string[] = []
  const setup = await loadProductionSetup({
    workspace: root,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname
      discoveryPaths.push(path)
      if (path === '/health')
        return new Response(
          JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }),
          { status: 200 },
        )
      return new Response(
        JSON.stringify({ data: [{ id: 'pi/openai-codex/gpt-5.6-luna', backend: 'pi' }] }),
        { status: 200 },
      )
    },
  })
  const profile = setup.profiles[0]
  const connection = setup.connections[0]
  assert.ok(profile)
  assert.ok(connection)
  if (!profile || !connection) return
  await saveProductionStartupSelection(join(root, '.braid', 'config.json'), {
    profile,
    connection,
    profileDigest: profile.digest,
    connectionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  })
  const saved = await readFile(join(root, '.braid', 'config.json'), 'utf8')
  assert.equal(JSON.parse(saved).schemaVersion, 2)
  assert.doesNotMatch(saved, /(?:secret|token|api[_-]?key)/iu)
  assert.match(saved, /braid-startup-config/u)
  assert.match(saved, /connection-local-cli-bridge/u)
  assert.equal(connection.endpoint, DEFAULT_CLI_BRIDGE_ENDPOINT)
  assert.equal(profile.profile.harness, 'pi')
  assert.equal(profile.profile.model?.default, 'openai-codex/gpt-5.6-luna')
  assert.deepEqual([...new Set(discoveryPaths)].sort(), ['/health', '/v1/models'])
  assert.equal(setup.verification.status, 'unverified')
  const effective = describeProductionSelection(
    {
      profile,
      connection,
      profileDigest: profile.digest,
      connectionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    },
    root,
    setup.verification,
  )
  assert.equal(effective.runner, 'pi')
  assert.equal(effective.model, 'openai-codex/gpt-5.6-luna')
  assert.equal(effective.effort, 'provider default (not pinned)')
  assert.equal(effective.workdir, root)
  assert.match(effective.verification, /^unverified:/u)
  assert.match(effective.unsupported.join('\n'), /provider workdir placement/u)
})

test('startup persistence keeps the exact profile and rejects inline credential material', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-profile-identity-'))
  const exactProfile = defineAgentProfile({
    ...profile(),
    metadata: {
      uiLabel: 'preserve this metadata',
      authenticationMethod: 'oauth',
      tokenBudget: 'large',
      bridgeCredential: { kind: 'secret-ref', key: 'cli-bridge-auth', format: 'bearer' },
    },
  })
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'test:exact-profile',
      label: 'Exact profile',
      writable: false,
      trusted: true,
    },
    exactProfile,
  )
  const selectedConnection = connection('cli-bridge', 'profile-identity', 'http://127.0.0.1:4010')
  await saveProductionStartupSelection(join(root, '.braid', 'config.json'), {
    profile: record,
    connection: selectedConnection,
    profileDigest: record.digest,
    connectionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  })
  const saved = await readFile(join(root, '.braid', 'config.json'), 'utf8')
  const restarted = await loadProductionStartup({ workspace: root })
  assert.deepEqual(restarted.profile, exactProfile)
  assert.equal(
    canonicalAgentProfileDigest(restarted.profile),
    canonicalAgentProfileDigest(exactProfile),
  )
  assert.match(saved, /preserve this metadata/u)
  assert.match(saved, /authenticationMethod/u)
  assert.match(saved, /tokenBudget/u)
  assert.doesNotMatch(saved, /\[redacted\]/u)
  assert.doesNotThrow(() =>
    persistableProductionProfile({
      ...profile(),
      metadata: {
        authenticationMethod: 'oauth',
        tokenBudget: 'large',
        documentation: 'Use Bearer tokens or Basic auth for the provider connection.',
      },
    }),
  )
  for (const value of ['Bearer CANARY-BEARER', 'Basic dXNlcjpwYXNz', 'api_key=inline-value']) {
    assert.throws(
      () =>
        persistableProductionProfile({
          ...profile(),
          metadata: { note: value },
        }),
      /typed secret-ref/iu,
      value,
    )
  }
  assert.throws(
    () =>
      persistableProductionProfile({
        ...profile(),
        hooks: { build: [{ command: 'echo', env: { BRIDGE_TOKEN: 'inline-secret-value' } }] },
      } as unknown as Readonly<AgentProfile>),
    /typed secret-ref/iu,
  )
  assert.throws(
    () =>
      persistableProductionProfile({
        ...profile(),
        mcp: {
          remote: {
            url: 'https://example.test/mcp',
            headers: { Authorization: 'inline-secret-value' },
          },
        },
      } as unknown as Readonly<AgentProfile>),
    /typed secret-ref/iu,
  )
  assert.throws(
    () =>
      persistableProductionProfile({
        ...profile(),
        metadata: { note: 'sk-proj-12345678901234567890' },
      }),
    /typed secret-ref/iu,
  )
})

test('protected Bridge auth survives setup, restart, and a real turn without persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-protected-'))
  await mkdir(join(root, '.braid'), { recursive: true })
  await chmod(join(root, '.braid'), 0o700)
  const model = 'opencode/zai-coding-plan/glm-5.2'
  const profileModel = 'zai-coding-plan/glm-5.2'
  const auth = 'protected-bridge-secret'
  const bridge = await startRuntimeBridgeServer({
    advertisedModels: [{ id: model, backend: 'opencode' }],
    expectedBearer: auth,
    responseText: 'protected response',
  })
  const endpoint = bridge.endpoint
  const validationRequests: Array<{
    readonly body: string
    readonly authorization: string | null
  }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const path = new URL(url).pathname
    const authorization = requestHeader(init, 'authorization')
    if (path === '/health') {
      assert.equal(authorization, `Bearer ${auth}`)
      return new Response(
        JSON.stringify({ status: 'ok', backends: [{ name: 'opencode', state: 'ready' }] }),
        { status: 200 },
      )
    }
    if (path === '/v1/models') {
      assert.equal(authorization, `Bearer ${auth}`)
      return new Response(JSON.stringify({ data: [{ id: model, backend: 'opencode' }] }), {
        status: 200,
      })
    }
    if (path === '/v1/chat/completions') {
      const body = typeof init?.body === 'string' ? init.body : ''
      const parsed = JSON.parse(body) as {
        readonly messages?: readonly { readonly content?: string }[]
      }
      if (parsed.messages?.[0]?.content?.includes('exactly OK') === true) {
        validationRequests.push({ body, authorization })
        assert.equal(authorization, `Bearer ${auth}`)
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
          status: 200,
        })
      }
    }
    return globalThis.fetch(input, init)
  }
  const credentials = new MemoryCredentialStore()
  const startupOptions = {
    workspace: root,
    cliBridgeEndpoint: endpoint,
    model,
    runner: 'opencode' as const,
    bridgeAuth: auth,
    fetch: fetcher,
    credentialStore: credentials,
    modelValidationTimeoutMs: 5_000,
  }
  const setup = await loadProductionSetup(startupOptions)
  const selectedProfile = setup.profiles.find(
    (candidate) => candidate.profile.model?.default === profileModel,
  )
  const selectedConnection = setup.connections[0]
  assert.ok(selectedProfile)
  assert.ok(selectedConnection)
  if (!selectedProfile || !selectedConnection) return
  const selection = {
    profile: selectedProfile,
    connection: selectedConnection,
    profileDigest: selectedProfile.digest,
    connectionDigest:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const,
  }
  const previous = createBraidApplication({ fixture: 'deterministic' })
  const active = {
    current: {
      app: previous,
      close: () => previous.close(),
    },
  }
  let firstHandle: Awaited<ReturnType<typeof openProductionApplication>> | undefined
  let secondHandle: Awaited<ReturnType<typeof openProductionApplication>> | undefined
  try {
    await transitionProductionSelection({
      setup,
      startupOptions,
      selection,
      workspace: root,
      controller: {
        replaceApplication: async () => undefined,
      },
      active,
      openApplication: async (nextSelection, nextOptions) => {
        firstHandle = await openProductionApplication({
          workspace: root,
          statePath: join(root, '.braid', 'before-restart.db'),
          startupOptions: nextOptions,
          production: productionConfigForSelection(nextSelection, nextOptions),
        })
        return firstHandle
      },
    })
    const saved = await readFile(join(root, '.braid', 'config.json'), 'utf8')
    const savedDocument = JSON.parse(saved) as {
      readonly connections?: readonly { readonly credentialRef?: string }[]
    }
    const savedCredentialRef = savedDocument.connections?.[0]?.credentialRef
    assert.match(savedCredentialRef ?? '', /^credential-cli-bridge-/u)
    assert.doesNotMatch(saved, new RegExp(auth, 'u'))
    assert.doesNotMatch(JSON.stringify(active.current.app.state()), new RegExp(auth, 'u'))

    const firstReceipt = active.current.app.send({
      operationId: 'op-protected-first-turn',
      text: 'protected first turn',
    })
    await firstReceipt.admissionReady
    const firstState = await firstReceipt.completion
    assert.equal(
      firstState.runs.at(-1)?.status,
      'completed',
      JSON.stringify(firstState.runs.at(-1)),
    )
    const firstRequest = bridge.requests[0]
    assert.ok(firstRequest)
    if (!firstRequest) return

    await active.current.close()
    const restartedOptions = {
      workspace: root,
      fetch: fetcher,
      credentialStore: credentials,
    }
    const restarted = await loadProductionStartup(restartedOptions)
    assert.equal(canonicalAgentProfileDigest(restarted.profile), selectedProfile.digest)
    assert.equal(restarted.connectionId, selectedConnection.id)
    assert.equal(restarted.connections[0]?.credentialRef, savedCredentialRef)
    secondHandle = await openProductionApplication({
      workspace: root,
      statePath: join(root, '.braid', 'after-restart.db'),
      startupOptions: restartedOptions,
      production: restarted,
    })
    const secondReceipt = secondHandle.app.send({
      operationId: 'op-protected-first-turn',
      text: 'protected first turn',
    })
    await secondReceipt.admissionReady
    const secondState = await secondReceipt.completion
    assert.equal(secondState.runs.at(-1)?.status, 'completed')
    const secondRequest = bridge.requests[1]
    assert.ok(secondRequest)
    if (!secondRequest) return
    assert.equal(firstRequest.authorization, `Bearer ${auth}`)
    assert.equal(secondRequest.authorization, `Bearer ${auth}`)
    const firstBody = firstRequest.body
    const secondBody = secondRequest.body
    assert.match(String(firstBody.run_id), /^run-/u)
    assert.match(String(secondBody.run_id), /^run-/u)
    assert.notEqual(secondBody.run_id, firstBody.run_id)
    assert.notEqual(secondBody.session_id, firstBody.session_id)
    for (const body of [firstBody, secondBody]) {
      const runId = String(body.run_id)
      assert.equal(body.session_id, `session-braid-${runId}`)
      assert.equal(body.execution_id, runId)
      // Runtime 0.142 writes only the environment ownership key into provider
      // metadata; turn and process identity stays in durable admissions.
      assert.deepEqual(body.metadata, {
        retainedIdempotencyKey: `environment-braid-session-braid-${runId}`,
      })
    }
    const stableBody = ({
      run_id: _runId,
      session_id: _sessionId,
      environment_id: _environmentId,
      execution_id: _executionId,
      metadata: _metadata,
      ...body
    }: Record<string, unknown>) => body
    assert.deepEqual(stableBody(secondBody), stableBody(firstBody))
    assert.equal(validationRequests.length, 1)
    assert.doesNotMatch(firstRequest.rawBody, new RegExp(auth, 'u'))
    assert.doesNotMatch(secondRequest.rawBody, new RegExp(auth, 'u'))
    assert.doesNotMatch(JSON.stringify(secondState), new RegExp(auth, 'u'))
  } finally {
    await secondHandle?.close().catch(() => undefined)
    await firstHandle?.close().catch(() => undefined)
    if (active.current.app !== previous) await active.current.close().catch(() => undefined)
    await previous.close().catch(() => undefined)
    await bridge.close().catch(() => undefined)
  }
})

test('headless key-backed Bridge auth works without OS keyring and keeps credential files outside workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-headless-auth-'))
  const keyDirectory = await mkdtemp(join(tmpdir(), 'braid-production-headless-key-'))
  const dataDirectory = await mkdtemp(join(tmpdir(), 'braid-production-headless-data-'))
  const keyPath = join(keyDirectory, 'database.key')
  const configPath = join(root, '.braid', 'config.json')
  const statePath = join(root, '.braid', 'state.db')
  await writeFile(keyPath, Buffer.alloc(32, 19), { mode: 0o600 })
  await chmod(keyPath, 0o600)
  const model = 'opencode/zai-coding-plan/glm-5.2'
  const profileModel = 'zai-coding-plan/glm-5.2'
  const auth = 'headless-bridge-secret'
  const bridge = await startRuntimeBridgeServer({
    advertisedModels: [{ id: model, backend: 'opencode' }],
    expectedBearer: auth,
    responseText: 'headless response',
  })
  const endpoint = bridge.endpoint
  const requests: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const path = new URL(url).pathname
    const authorization = requestHeader(init, 'authorization')
    if (path === '/health' || path === '/v1/models') {
      assert.equal(authorization, `Bearer ${auth}`)
      return path === '/health'
        ? new Response(
            JSON.stringify({ status: 'ok', backends: [{ name: 'opencode', state: 'ready' }] }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ data: [{ id: model, backend: 'opencode' }] }), {
            status: 200,
          })
    }
    if (path === '/v1/chat/completions') {
      const body = typeof init?.body === 'string' ? init.body : ''
      const parsed = JSON.parse(body) as {
        readonly messages?: readonly { readonly content?: string }[]
      }
      if (parsed.messages?.[0]?.content?.includes('exactly OK') === true) {
        requests.push(body)
        assert.equal(authorization, `Bearer ${auth}`)
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
          status: 200,
        })
      }
    }
    return globalThis.fetch(input, init)
  }
  const context = createProductionCredentialContext({
    workspace: root,
    configPath,
    databaseKeyFile: keyPath,
    dataDirectory,
  })
  assert.ok(context)
  if (!context) return
  assert.ok(context.store instanceof HeadlessCredentialStore)
  const releaseContext = context.acquire()
  const startupOptions = {
    workspace: root,
    configPath,
    cliBridgeEndpoint: endpoint,
    model,
    runner: 'opencode' as const,
    bridgeAuth: auth,
    fetch: fetcher,
    databaseKeyFile: context.databaseKeyFile,
    credentialStore: context.store,
    credentialContext: context,
    modelValidationTimeoutMs: 5_000,
  }
  let firstHandle: Awaited<ReturnType<typeof openProductionApplication>> | undefined
  let secondHandle: Awaited<ReturnType<typeof openProductionApplication>> | undefined
  let restartedContext: ReturnType<typeof createProductionCredentialContext> | undefined
  const previous = createBraidApplication({ fixture: 'deterministic' })
  const active = { current: { app: previous, close: () => previous.close() } }
  try {
    const setup = await loadProductionSetup(startupOptions)
    const selectedProfile = setup.profiles.find(
      (candidate) => candidate.profile.model?.default === profileModel,
    )
    const selectedConnection = setup.connections[0]
    assert.ok(selectedProfile)
    assert.ok(selectedConnection)
    if (!selectedProfile || !selectedConnection) return
    const selection = {
      profile: selectedProfile,
      connection: selectedConnection,
      profileDigest: selectedProfile.digest,
      connectionDigest:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const,
    }
    await transitionProductionSelection({
      setup,
      startupOptions,
      selection,
      workspace: root,
      controller: { replaceApplication: async () => undefined },
      active,
      openApplication: async (nextSelection, nextOptions) => {
        firstHandle = await openProductionApplication({
          workspace: root,
          statePath,
          startupOptions: nextOptions,
          production: productionConfigForSelection(nextSelection, nextOptions),
        })
        return firstHandle
      },
    })
    const saved = await readFile(configPath, 'utf8')
    const savedDocument = JSON.parse(saved) as {
      readonly connections?: readonly { readonly credentialRef?: string }[]
    }
    const savedCredentialId = savedDocument.connections?.[0]?.credentialRef
    assert.match(savedCredentialId ?? '', /^credential-cli-bridge-/u)
    assert.doesNotMatch(saved, new RegExp(auth, 'u'))
    assert.doesNotMatch(saved, /headless-bridge-secret/u)

    const firstReceipt = active.current.app.send({
      operationId: 'op-headless-first-turn',
      text: 'headless first turn',
    })
    await firstReceipt.admissionReady
    const firstState = await firstReceipt.completion
    assert.equal(
      firstState.runs.at(-1)?.status,
      'completed',
      JSON.stringify(firstState.runs.at(-1)),
    )
    await active.current.close()

    const nextContext = createProductionCredentialContext({
      workspace: root,
      configPath,
      databaseKeyFile: keyPath,
      dataDirectory,
    })
    assert.ok(nextContext)
    if (!nextContext) return
    restartedContext = nextContext
    const restartedOptions = {
      workspace: root,
      configPath,
      fetch: fetcher,
      databaseKeyFile: nextContext.databaseKeyFile,
      credentialStore: nextContext.store,
      credentialContext: nextContext,
    }
    const restarted = await loadProductionStartup(restartedOptions)
    assert.equal(restarted.connections[0]?.credentialRef, savedCredentialId)
    secondHandle = await openProductionApplication({
      workspace: root,
      statePath,
      startupOptions: restartedOptions,
      production: restarted,
    })
    const secondReceipt = secondHandle.app.send({
      operationId: 'op-headless-restart-turn',
      text: 'headless restart turn',
    })
    await secondReceipt.admissionReady
    assert.equal((await secondReceipt.completion).runs.at(-1)?.status, 'completed')
    assert.equal(requests.length, 1)
    assert.match(requests[0] ?? '', /exactly OK/u)
    assert.equal(bridge.requests.length, 2)
    assert.equal(bridge.requests[0]?.authorization, `Bearer ${auth}`)
    assert.equal(bridge.requests[1]?.authorization, `Bearer ${auth}`)

    const credentialRoot = join(dataDirectory, 'credentials')
    const [digestDirectory] = await readdir(credentialRoot)
    assert.match(digestDirectory ?? '', /^[0-9a-f]{64}$/u)
    if (!digestDirectory) return
    const swappedWorkspace = await mkdtemp(join(tmpdir(), 'braid-production-headless-swap-'))
    const swappedContext = createProductionCredentialContext({
      workspace: swappedWorkspace,
      configPath: join(swappedWorkspace, '.braid', 'config.json'),
      databaseKeyFile: keyPath,
      dataDirectory,
    })
    assert.ok(swappedContext)
    if (!swappedContext) return
    try {
      await swappedContext.store.available()
      const contextDirectories = await readdir(credentialRoot)
      const sourceRoot = join(credentialRoot, digestDirectory)
      const targetDirectory = contextDirectories.find((directory) => directory !== digestDirectory)
      assert.ok(targetDirectory)
      if (!targetDirectory) return
      const targetRoot = join(credentialRoot, targetDirectory)
      for (const file of await readdir(sourceRoot)) {
        await copyFile(join(sourceRoot, file), join(targetRoot, file))
      }
      await assert.rejects(
        () => swappedContext.store.resolve(credentialRef(`cred:v1:${savedCredentialId}`)),
        /encrypted headless credential is invalid/iu,
      )
    } finally {
      swappedContext.dispose()
    }

    const orphan = await prepareProductionSelection(
      { ...restartedOptions, bridgeAuth: 'orphan-headless-secret' },
      selection,
      configPath,
    )
    const orphanId = orphan.selection.connection.credentialRef
    assert.ok(orphanId)
    if (!orphanId) return
    await recoverPendingProductionCredential(configPath, {
      credentialContext: nextContext,
    })
    await assert.rejects(
      () => nextContext.store.resolve(credentialRef(`cred:v1:${orphanId}`)),
      /not found/iu,
    )
    await orphan.commit()

    await assert.rejects(() => access(join(root, '.braid', 'credentials')))
    assert.equal((await stat(join(credentialRoot, digestDirectory))).mode & 0o777, 0o700)
    const credentialFiles = await readdir(join(credentialRoot, digestDirectory))
    assert.ok(credentialFiles.length > 0)
    for (const file of credentialFiles) {
      assert.equal((await stat(join(credentialRoot, digestDirectory, file))).mode & 0o777, 0o600)
    }
  } finally {
    await secondHandle?.close().catch(() => undefined)
    await firstHandle?.close().catch(() => undefined)
    if (active.current.app !== previous) await active.current.close().catch(() => undefined)
    await previous.close().catch(() => undefined)
    restartedContext?.dispose()
    releaseContext()
    context.dispose()
    await bridge.close().catch(() => undefined)
  }
})

test('protected setup removes a newly stored credential on failed transition and fails before validation without secure storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-credential-rollback-'))
  const endpoint = 'https://bridge.example.test'
  const auth = 'rollback-only-secret'
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ data: [{ id: 'pi/openai-codex/gpt-5.6-luna' }] }), {
      status: 200,
    })
  }
  const setup = await loadProductionSetup({
    workspace: root,
    cliBridgeEndpoint: endpoint,
    bridgeAuth: auth,
    fetch: fetcher,
  })
  const selectedProfile = setup.profiles[0]
  const selectedConnection = setup.connections[0]
  assert.ok(selectedProfile)
  assert.ok(selectedConnection)
  if (!selectedProfile || !selectedConnection) return
  const selection = {
    profile: selectedProfile,
    connection: selectedConnection,
    profileDigest: selectedProfile.digest,
    connectionDigest:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const,
  }
  const credentials = new MemoryCredentialStore()
  const stored: string[] = []
  const removed: string[] = []
  const recordingCredentials = {
    available: () => credentials.available(),
    store: async (input: Parameters<MemoryCredentialStore['store']>[0]) => {
      const ref = await credentials.store(input)
      stored.push(ref)
      return ref
    },
    resolve: (ref: Parameters<MemoryCredentialStore['resolve']>[0]) => credentials.resolve(ref),
    remove: async (ref: Parameters<MemoryCredentialStore['remove']>[0]) => {
      removed.push(ref)
      await credentials.remove(ref)
    },
  }
  const previous = createBraidApplication({ fixture: 'deterministic' })
  const active = { current: { app: previous, close: () => previous.close() } }
  try {
    await assert.rejects(
      transitionProductionSelection({
        setup,
        startupOptions: {
          ...setupOptionsForCredentialTest(root, endpoint, auth, fetcher),
          credentialStore: recordingCredentials,
        },
        selection,
        workspace: root,
        controller: { replaceApplication: async () => undefined },
        active,
        validate: async () => {
          throw new Error('validation failed after secure credential write')
        },
        openApplication: async () => {
          throw new Error('open must not run after validation failure')
        },
      }),
      /validation failed after secure credential write/u,
    )
    assert.equal(stored.length, 1)
    assert.deepEqual(removed, stored)
    assert.equal(credentials.has(stored[0] as never), false)

    const unavailable = new MemoryCredentialStore()
    unavailable.setAvailable(false)
    let validationCalls = 0
    await assert.rejects(
      transitionProductionSelection({
        setup,
        startupOptions: {
          ...setupOptionsForCredentialTest(root, endpoint, auth, fetcher),
          credentialStore: unavailable,
        },
        selection,
        workspace: root,
        controller: { replaceApplication: async () => undefined },
        active,
        validate: async () => {
          validationCalls += 1
          return { status: 'verified', detail: 'must not run' }
        },
        openApplication: async () => {
          throw new Error('open must not run without secure storage')
        },
      }),
      /secure.*credential store.*unavailable/iu,
    )
    assert.equal(validationCalls, 0)
  } finally {
    await previous.close()
  }
})

test('pending credential markers recover both an interrupted and a committed setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-credential-recovery-'))
  const { setup, selection } = await transitionSetup(root)
  const configPath = setup.configPath
  const credentials = new MemoryCredentialStore()
  const interrupted = await prepareProductionSelection(
    { workspace: root, bridgeAuth: 'interrupted-secret', credentialStore: credentials },
    selection,
    configPath,
  )
  const interruptedRef = credentialRef(
    `cred:v1:${interrupted.selection.connection.credentialRef ?? 'missing'}`,
  )
  assert.equal(credentials.has(interruptedRef), true)
  await recoverPendingProductionCredential(configPath, { credentialStore: credentials })
  assert.equal(credentials.has(interruptedRef), false)
  await assert.rejects(() => access(`${configPath}.pending-cli-bridge`), /ENOENT/u)

  const committed = await prepareProductionSelection(
    { workspace: root, bridgeAuth: 'committed-secret', credentialStore: credentials },
    selection,
    configPath,
  )
  const committedRef = credentialRef(
    `cred:v1:${committed.selection.connection.credentialRef ?? 'missing'}`,
  )
  await saveProductionStartupSelection(configPath, committed.selection)
  await recoverPendingProductionCredential(configPath, { credentialStore: credentials })
  assert.equal(credentials.has(committedRef), true)
  assert.equal(
    await access(`${configPath}.pending-cli-bridge`).then(
      () => true,
      () => false,
    ),
    false,
  )
})

function setupOptionsForCredentialTest(
  workspace: string,
  endpoint: string,
  auth: string,
  fetcher: typeof fetch,
) {
  return {
    workspace,
    cliBridgeEndpoint: endpoint,
    bridgeAuth: auth,
    fetch: fetcher,
  }
}

test('CLI Bridge discovery classifies service and backend readiness from the health contract', async () => {
  const cases = [
    {
      name: 'malformed 200',
      status: 200,
      body: '{}',
      expected: 'incompatible',
      diagnostic: /malformed|readiness is unknown/iu,
    },
    {
      name: 'unauthorized 401',
      status: 401,
      body: JSON.stringify({ error: { code: 'unauthorized' } }),
      expected: 'unauthorized',
      diagnostic: /HTTP 401/u,
    },
    {
      name: 'rate limited 429',
      status: 429,
      body: JSON.stringify({ error: { code: 'rate_limited' } }),
      expected: 'rate-limited',
      diagnostic: /HTTP 429/u,
    },
    {
      name: 'degraded with a ready backend',
      status: 200,
      body: JSON.stringify({
        status: 'degraded',
        backends: [
          { name: 'pi', state: 'ready' },
          { name: 'codex', state: 'unavailable' },
        ],
      }),
      expected: 'healthy',
      diagnostic: /degraded service with ready backends: pi/iu,
    },
    {
      name: 'degraded with no ready backend',
      status: 503,
      body: JSON.stringify({
        status: 'degraded',
        backends: [{ name: 'pi', state: 'unavailable' }],
      }),
      expected: 'unreachable',
      diagnostic: /HTTP 503.*degraded service with no ready backend/iu,
    },
    {
      name: 'ok with all backends ready',
      status: 200,
      body: JSON.stringify({
        status: 'ok',
        backends: [
          { name: 'pi', state: 'ready' },
          { name: 'codex', state: 'ready' },
        ],
      }),
      expected: 'healthy',
      diagnostic: undefined,
    },
  ] as const

  for (const healthCase of cases) {
    const root = await mkdtemp(
      join(tmpdir(), `braid-health-${healthCase.name.replaceAll(' ', '-')}-`),
    )
    const result = await discoverBridge(
      {
        workspace: root,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname
          if (path === '/health')
            return new Response(healthCase.body, { status: healthCase.status })
          return new Response(
            JSON.stringify({ data: [{ id: 'pi/openai-codex/gpt-5.6-luna', backend: 'pi' }] }),
            { status: 200 },
          )
        },
      },
      DEFAULT_CLI_BRIDGE_ENDPOINT,
    )
    assert.equal(result.health.status, healthCase.expected, healthCase.name)
    if (healthCase.diagnostic === undefined) {
      assert.deepEqual(result.diagnostics, [], healthCase.name)
    } else {
      assert.match(result.diagnostics.join('\n'), healthCase.diagnostic, healthCase.name)
    }
  }
})

test('first-run catalog preserves trusted profiles and adds each advertised model once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-catalog-'))
  await mkdir(join(root, '.braid'), { recursive: true })
  const trustedUnavailable = defineAgentProfile({
    name: 'trusted unavailable target',
    harness: 'pi',
    model: { default: 'openai/gpt-9-not-advertised' },
  })
  const trustedGlm = defineAgentProfile({
    name: 'trusted GLM profile',
    harness: 'opencode',
    model: { default: 'zai-coding-plan/glm-5.2' },
  })
  await writeFile(
    join(root, '.braid', 'profile.json'),
    `${canonicalCandidateJson(trustedUnavailable)}\n`,
    { mode: 0o600 },
  )
  await writeFile(join(root, 'braid.profile.json'), `${canonicalCandidateJson(trustedGlm)}\n`, {
    mode: 0o600,
  })
  const fetch: typeof globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', backends: [{ name: 'opencode', state: 'ready' }] }),
        { status: 200 },
      )
    }
    return new Response(
      JSON.stringify({
        data: [
          { id: 'pi/openai-codex/gpt-5.6-luna', backend: 'pi' },
          { id: 'opencode/zai-coding-plan/glm-5.2', backend: 'opencode' },
        ],
      }),
      { status: 200 },
    )
  }
  const setup = await loadProductionSetup({ workspace: root, fetch })
  assert.equal(
    setup.profiles.some((record) => record.profile.name === trustedUnavailable.name),
    true,
  )
  assert.equal(
    setup.profiles.some((record) => record.profile.name === trustedGlm.name),
    true,
  )
  assert.equal(
    setup.profiles.filter((record) => record.profile.model?.default === 'zai-coding-plan/glm-5.2')
      .length,
    1,
  )
  assert.equal(
    setup.profiles.filter((record) => record.profile.model?.default === 'openai-codex/gpt-5.6-luna')
      .length,
    1,
  )

  const constrained = await loadProductionSetup({
    workspace: root,
    fetch,
    runner: 'opencode',
    model: 'opencode/zai-coding-plan/glm-5.2',
  })
  assert.equal(constrained.profiles.length, setup.profiles.length)
  const initial = constrained.profiles.find((record) => record.id === constrained.initialProfileId)
  assert.equal(initial?.profile.harness, 'opencode')
  assert.equal(initial?.profile.model?.default, 'zai-coding-plan/glm-5.2')
})

test('configured restart keeps alternate profiles and routes each run from its AgentProfile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-restart-profiles-'))
  await mkdir(join(root, '.braid'), { recursive: true })
  const product = defineAgentProfile({
    name: 'Product engineer',
    harness: 'claude-code',
    model: { default: 'opus' },
  })
  const analyst = defineAgentProfile({
    name: 'Trace analyst',
    harness: 'claude-code',
    model: { default: 'sonnet' },
  })
  await writeFile(join(root, '.braid', 'profile.json'), `${canonicalCandidateJson(analyst)}\n`, {
    mode: 0o600,
  })
  const selectedConnection = connection('cli-bridge', 'restart-profiles', 'http://127.0.0.1:3345')
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const path = url.pathname
    if (path === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', backends: [{ name: 'claude-code', state: 'ready' }] }),
        { status: 200 },
      )
    }
    if (path === '/v1/capabilities') {
      return new Response(
        JSON.stringify(bridgeCapabilityDocument(url.searchParams.get('model') ?? '')),
        { status: 200 },
      )
    }
    return new Response(
      JSON.stringify({
        data: [
          { id: 'claude-code/opus', backend: 'claude-code' },
          { id: 'claude-code/sonnet', backend: 'claude-code' },
        ],
      }),
      { status: 200 },
    )
  }
  const catalog = await loadProductionProfileCatalog(
    { workspace: root, fetch },
    { profile: product, connections: [selectedConnection], connectionId: selectedConnection.id },
    selectedConnection.id,
  )
  assert.deepEqual(catalog.map((record) => record.profile.name).sort(), [
    'Product engineer',
    'Trace analyst',
  ])

  const composition = createProductionComposition({
    profile: product,
    connections: [selectedConnection],
    connectionId: selectedConnection.id,
    workspaceRoot: root,
    connectionOptions: { fetch },
  })
  const admission = await composition.execution.admit?.({
    operationId: 'operation-restart-profile-route',
    runId: 'run-restart-profile-route',
    text: 'Review the retained run.',
    profile: analyst,
    connectionId: selectedConnection.id,
    workspaceRoot: root,
    signal: new AbortController().signal,
  })
  assert.equal(admission?.materializationReceipt?.route, 'claude-code/sonnet')
})

test('first-run catalog keeps the Codex route out of the portable profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-codex-route-'))
  const fetch: typeof globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', backends: [{ name: 'codex', state: 'ready' }] }),
        { status: 200 },
      )
    }
    return new Response(
      JSON.stringify({
        data: [
          { id: 'codex/default', backend: 'codex' },
          { id: 'pi/openai-codex/gpt-5.6-luna', backend: 'codex' },
        ],
      }),
      { status: 200 },
    )
  }
  const setup = await loadProductionSetup({
    workspace: root,
    fetch,
    runner: 'codex',
    model: 'codex/default',
  })
  const initial = setup.profiles.find((record) => record.id === setup.initialProfileId)
  assert.equal(initial?.profile.harness, 'codex')
  assert.equal(initial?.profile.model?.default, 'default')
  assert.equal(initial?.profile.model?.provider, undefined)
  assert.equal(
    setup.profiles.some((record) => record.profile.model?.default === 'openai-codex/gpt-5.6-luna'),
    false,
  )
  assert.doesNotMatch(setup.diagnostics.join('\n'), /requested model|requested runner/iu)
})

test('first-run setup returns an honest empty catalog without a fake model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-empty-catalog-'))
  const setup = await loadProductionSetup({
    workspace: root,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/health') {
        return new Response(
          JSON.stringify({ status: 'degraded', backends: [{ name: 'pi', state: 'unavailable' }] }),
          { status: 503 },
        )
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    },
  })
  assert.deepEqual(setup.profiles, [])
  assert.match(
    setup.diagnostics.join('\n'),
    /No trusted AgentProfile.*compatible advertised model/iu,
  )
  assert.doesNotMatch(setup.diagnostics.join('\n'), /codex\/default/iu)
})

test('first-run model validation stays in setup with an actionable 501 remedy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-validation-'))
  const setup = await loadProductionSetup({
    workspace: root,
    fetch: async (input) => {
      const url = String(input)
      if (url.endsWith('/health'))
        return new Response(
          JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }),
          { status: 200 },
        )
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'pi/openai-codex/gpt-5.6-luna', backend: 'pi' }] }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected discovery request: ${url}`)
    },
  })
  const profile = setup.profiles[0]
  const connection = setup.connections[0]
  assert.ok(profile)
  assert.ok(connection)
  if (!profile || !connection) return
  const selection = {
    profile,
    connection,
    profileDigest: profile.digest,
    connectionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  }
  const temporary = createBraidApplication({ fixture: 'deterministic' })
  let transitioned = false
  try {
    await assert.rejects(
      () =>
        transitionProductionSelection({
          setup,
          startupOptions: {
            workspace: root,
            fetch: async (input, init) => {
              const url = String(input)
              assert.equal(init?.method, 'POST')
              assert.match(url, /\/chat\/completions$/u)
              return new Response(
                JSON.stringify({ error: { type: 'not_configured', message: 'pi auth missing' } }),
                { status: 501 },
              )
            },
          },
          selection,
          workspace: root,
          controller: {
            replaceApplication: async () => {
              transitioned = true
            },
          },
          active: {
            current: {
              app: temporary,
              close: async () => temporary.close(),
            },
          },
          openApplication: async () => {
            throw new Error('the durable application must not open after failed validation')
          },
        }),
      /501 not_configured.*Configure.*credentials/isu,
    )
    assert.equal(transitioned, false)
    await assert.rejects(
      () => access(join(root, '.braid', 'config.json')),
      (error: unknown) =>
        error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT',
    )
  } finally {
    await temporary.close()
  }
})

test('first-run model validation rejects a non-marker completion body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-validation-marker-'))
  const setup = await loadProductionSetup({
    workspace: root,
    fetch: async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) {
        return new Response(
          JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'pi/openai-codex/gpt-5.6-luna', backend: 'pi' }] }),
        { status: 200 },
      )
    },
  })
  const selectedProfile = setup.profiles[0]
  const selectedConnection = setup.connections[0]
  assert.ok(selectedProfile)
  assert.ok(selectedConnection)
  if (!selectedProfile || !selectedConnection) return
  await assert.rejects(
    () =>
      validateProductionSelection(
        {
          workspace: root,
          fetch: async (_input, init) => {
            assert.equal(init?.method, 'POST')
            return new Response(JSON.stringify({ choices: [{ message: { content: 'NOT OK' } }] }), {
              status: 200,
            })
          },
        },
        {
          profile: selectedProfile,
          connection: selectedConnection,
          profileDigest: selectedProfile.digest,
          connectionDigest:
            'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
      ),
    /exact OK completion/iu,
  )
})

test('first-run model validation authorizes its token limit in a separate AgentProfile field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-validation-profile-'))
  const setup = await loadProductionSetup({
    workspace: root,
    effort: 'high',
    fetch: async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) {
        return new Response(
          JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'pi/tangle-router/glm-5.2', backend: 'pi' }] }),
        { status: 200 },
      )
    },
  })
  const selectedProfile = setup.profiles[0]
  const selectedConnection = setup.connections[0]
  assert.ok(selectedProfile)
  assert.ok(selectedConnection)
  if (!selectedProfile || !selectedConnection) return
  let body: Record<string, unknown> | undefined
  const result = await validateProductionSelection(
    {
      workspace: root,
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
          status: 200,
        })
      },
    },
    {
      profile: selectedProfile,
      connection: selectedConnection,
      profileDigest: selectedProfile.digest,
      connectionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    },
  )

  assert.equal(result.status, 'verified')
  assert.equal(body?.model, 'pi/tangle-router/glm-5.2')
  assert.equal(body?.max_tokens, 1)
  const validationProfile = body?.agent_profile as {
    readonly harness?: unknown
    readonly model?: {
      readonly default?: unknown
      readonly provider?: unknown
      readonly reasoningEffort?: unknown
      readonly maxVisibleOutputTokens?: unknown
      readonly maxTotalOutputTokens?: unknown
      readonly metadata?: Record<string, unknown>
    }
  }
  assert.equal(validationProfile.harness, 'pi')
  assert.equal(validationProfile.model?.default, 'tangle-router/glm-5.2')
  assert.equal(validationProfile.model?.provider, 'tangle-router')
  assert.equal(validationProfile.model?.reasoningEffort, 'high')
  assert.equal(validationProfile.model?.maxVisibleOutputTokens, 1)
  assert.equal(validationProfile.model?.maxTotalOutputTokens, 1)
  assert.equal(validationProfile.model?.metadata, undefined)
  assert.equal('effort' in (body ?? {}), false)
})

test('production selection transition keeps its lifecycle order across injected failures', async () => {
  const phases = ['validate', 'open', 'persist', 'swap', 'old-close'] as const
  for (const phase of phases) {
    const root = await mkdtemp(join(tmpdir(), `braid-transition-${phase}-`))
    const { setup, selection } = await transitionSetup(root)
    const events: string[] = []
    const previousApp = createBraidApplication({ fixture: 'deterministic' })
    let previousClosed = false
    const previous = {
      app: previousApp,
      close: async () => {
        if (previousClosed) return
        previousClosed = true
        events.push('old-close')
        if (phase === 'old-close') throw new Error('injected old close failure')
        await previousApp.close()
      },
    }
    const active = { current: previous }
    let next:
      | {
          readonly app: ReturnType<typeof createBraidApplication>
          readonly close: () => Promise<void>
        }
      | undefined
    let controllerApp = previousApp
    const controller = {
      replaceApplication: async (application: ReturnType<typeof createBraidApplication>) => {
        events.push('swap')
        if (phase === 'swap') throw new Error('injected controller swap failure')
        controllerApp = application
      },
    }
    try {
      const transition = transitionProductionSelection({
        setup,
        startupOptions: { workspace: root },
        selection,
        workspace: root,
        controller,
        active,
        validate: async () => {
          events.push('validate')
          if (phase === 'validate') throw new Error('injected validation failure')
          return { status: 'verified', detail: 'injected validation passed' }
        },
        openApplication: async () => {
          events.push('open')
          if (phase === 'open') throw new Error('injected open failure')
          const app = createBraidApplication({ fixture: 'deterministic' })
          let closed = false
          const handle = {
            app,
            close: async () => {
              if (closed) return
              closed = true
              events.push('next-close')
              await app.close()
            },
          }
          next = handle
          return handle
        },
        persist: async () => {
          events.push('persist')
          if (phase === 'persist') throw new Error('injected persist failure')
          return {
            rollback: async () => {
              events.push('rollback')
            },
          }
        },
      })
      if (phase === 'old-close') {
        const verification = await transition
        assert.equal(verification.status, 'verified')
      } else {
        const expectedFailure =
          phase === 'validate' ? 'validation' : phase === 'swap' ? 'controller swap' : phase
        await assert.rejects(
          transition,
          (error: unknown) =>
            error instanceof Error && error.message === `injected ${expectedFailure} failure`,
        )
      }
      const expected =
        phase === 'validate'
          ? ['validate']
          : phase === 'open'
            ? ['validate', 'open']
            : phase === 'persist'
              ? ['validate', 'open', 'persist', 'next-close']
              : phase === 'swap'
                ? ['validate', 'open', 'persist', 'swap', 'rollback', 'next-close']
                : ['validate', 'open', 'persist', 'swap', 'old-close']
      assert.deepEqual(events, expected, phase)
      if (phase === 'old-close') {
        assert.equal(active.current.app, next?.app, phase)
        assert.equal(controllerApp, next?.app, phase)
      } else {
        assert.equal(active.current.app, previousApp, phase)
        assert.equal(controllerApp, previousApp, phase)
      }
    } finally {
      if (active.current.app === previousApp) await previous.close().catch(() => undefined)
      if (next !== undefined && active.current.app !== next.app)
        await next.close().catch(() => undefined)
      if (active.current.app === next?.app) await next.close().catch(() => undefined)
    }
  }
})

test('failed controller activation rolls back persisted config and keeps controller and active app aligned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-transition-crash-safe-'))
  const { setup, selection } = await transitionSetup(root)
  const oldProfile = defineAgentProfile({
    name: 'old active profile',
    harness: 'pi',
    model: { default: 'openai/old' },
  })
  const oldApp = createBraidApplication({ fixture: 'deterministic', profile: oldProfile })
  oldApp.initialize(root)
  const controller = new ApplicationUiController(oldApp)
  const active = {
    current: {
      app: oldApp,
      close: () => oldApp.close(),
    },
  }
  const failingJournal = new MemoryJournal(new FixedClock())
  Object.defineProperty(failingJournal, 'flush', {
    configurable: true,
    value: async () => {
      throw new Error('injected controller durability failure')
    },
  })
  const nextApp = createBraidApplication({
    fixture: 'deterministic',
    profile: defineAgentProfile({
      name: 'new candidate profile',
      harness: 'pi',
      model: { default: 'openai/new' },
    }),
    journal: failingJournal,
    effectStorage: failingJournal,
  })
  let nextClosed = false
  try {
    await assert.rejects(
      () =>
        transitionProductionSelection({
          setup,
          startupOptions: { workspace: root },
          selection,
          workspace: root,
          controller,
          active,
          validate: async () => ({ status: 'verified', detail: 'injected validation passed' }),
          openApplication: async () => ({
            app: nextApp,
            close: async () => {
              nextClosed = true
              await nextApp.close().catch(() => undefined)
            },
          }),
        }),
      /injected controller durability failure/iu,
    )
    assert.equal(active.current.app, oldApp)
    assert.equal(controller.view().profileName, 'old active profile')
    assert.equal(nextClosed, true)
    await assert.rejects(
      () => access(setup.configPath),
      (error: unknown) =>
        error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT',
    )
  } finally {
    await oldApp.close().catch(() => undefined)
  }
})

test('bin startup reports missing production config before opening storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-production-missing-'))
  await assert.rejects(
    () => loadProductionStartup({ workspace: root }),
    (error: unknown) =>
      error instanceof ProductionStartupError &&
      error.code === 'PRODUCTION_CONFIGURATION_NOT_FOUND' &&
      /--config/iu.test(error.message),
  )
})

test('bin startup preserves the actionable encrypted-storage prerequisite', () => {
  const error = Object.assign(
    new Error('The operating-system credential facility is unavailable'),
    { code: 'CREDENTIAL_STORE_UNAVAILABLE' },
  )
  assert.equal(
    formatProductionStartupError(error),
    'CREDENTIAL_STORE_UNAVAILABLE: The operating-system credential facility is unavailable',
  )
  assert.equal(
    formatProductionStartupError(new Error('unexpected provider detail')),
    'PROVIDER_ERROR',
  )
})
