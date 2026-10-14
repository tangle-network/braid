import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type AgentProfile, defineAgentProfile } from '@tangle-network/agent-interface'
// @ts-expect-error The scanner is a JavaScript release helper without a product declaration.
import { assertNoSecretArtifacts } from '../scripts/scan-secret-artifacts.mjs'
import { bindCredentialToOrigin } from '../src/adapters/connections/production-connection-credentials.js'
import { createTangleEnvironmentProvider } from '../src/adapters/connections/production-connection-providers.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { resolveTangleSandboxRetainedConnection } from '../src/adapters/runtime/production-tangle-sandbox-backend.js'
import {
  createProviderRetainedPlan,
  startProviderRetainedRun,
} from '../src/adapters/runtime/provider-retained-run.js'
import { interactiveEnvironment } from '../src/adapters/runtime/tangle-retained-interactive-contract.js'
import {
  createBraidApplication,
  createDurableBraidApplication,
  DETERMINISTIC_PROFILE,
  type DurableBraidApplication,
} from '../src/app/composition.js'
import { ConnectionActionService } from '../src/app/connection-actions.js'
import { ConnectionError } from '../src/app/connection-errors.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import { MemoryJournal } from '../src/app/journal.js'
import { createAdmissionReceipt } from '../src/domain/receipts.js'
import type { RetainedRunAdmissionRecord } from '../src/ports/execution.js'
import { activateProductionConnection } from '../src/bin/production-application.js'
import type { ConnectionRecord, ConnectionTransportOptions } from '../src/domain/entities.js'
import { createConnectionId, createCredentialRefId } from '../src/domain/ids.js'
import { assertConnectionRecord } from '../src/domain/invariants-profile.js'
import { redactBraidEvent } from '../src/domain/redaction.js'
import { FixedClock } from '../src/ports/clock.js'
import { credentialRef } from '../src/ports/credentials.js'
import { RandomIds } from '../src/ports/ids.js'
import { FakeTangleRetainedSandbox } from './support/tangle-retained-sandbox.js'

const at = '2026-10-14T12:00:00.000Z'
const endpoint = 'https://sandbox.tangle.tools'
// Credential-shaped test values. None may appear in a refusal, event, state, or Sandbox request.
const VALUE_CANARY = `ghp_${'SeatCanary'.repeat(4)}`
const KEY_CANARY = 'braid-seat-key-canary-Q7m2Zx9Lp4'
const FORWARDED_CANARY = 'braid-forwarded-canary-R8n3Yw0Kq5'
const GRANTED = ['BRAID_PROOF_GH_TOKEN', 'BRAID_PROOF_NPM'] as const

function record(
  providerOptions: ConnectionTransportOptions,
  kind: ConnectionRecord['kind'] = 'tangle-sandbox',
): ConnectionRecord {
  return {
    id: createConnectionId('connection-tangle-seats'),
    kind,
    name: 'Tangle seats',
    endpoint,
    providerOptions: { transport: 'https', ...providerOptions },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}

function subscriptionProfile(harness: 'opencode' | 'claude-code'): Readonly<AgentProfile> {
  return defineAgentProfile({
    name: `Seat proof ${harness}`,
    harness,
    model:
      harness === 'claude-code'
        ? {
            provider: 'anthropic',
            default: 'claude-opus-5-5',
            metadata: { credentialSource: 'subscription' },
          }
        : {
            provider: 'openai',
            default: 'openai/gpt-5',
            metadata: { credentialSource: 'subscription' },
          },
  })
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12).toUpperCase()
}

/**
 * A resolver that proves which values reached it without printing them: each public field it
 * returns carries a digest of one private variable.
 */
async function resolverScript(output: 'cliAuth' | 'apiKeyEnv'): Promise<{
  readonly directory: string
  readonly path: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'braid-seat-resolver-'))
  const path = join(directory, 'seat-resolver.mjs')
  await writeFile(
    path,
    [
      "import { createHash } from 'node:crypto'",
      "const hash = (name) => createHash('sha256').update(process.env[name] ?? '').digest('hex').slice(0, 12).toUpperCase()",
      "let request = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => { request += chunk })",
      "process.stdin.on('end', () => {",
      '  const parsed = JSON.parse(request)',
      "  if (typeof parsed.input?.idempotencyKey !== 'string') process.exit(3)",
      "  const seat = 'SEAT_' + hash('BRAID_SEAT_CONNECTION_KEY')",
      output === 'cliAuth'
        ? "  process.stdout.write(JSON.stringify({ cliAuth: { account: 'seat-' + hash('BRAID_SEAT_FORWARDED').toLowerCase(), secretEnv: seat, format: 'token' } }))"
        : "  process.stdout.write(JSON.stringify({ apiKeyEnv: seat, baseUrl: process.env.BRAID_SEAT_ENDPOINT + '/seat/' + hash('BRAID_SEAT_FORWARDED') }))",
      '})',
      '',
    ].join('\n'),
  )
  return { directory, path }
}

async function storedConnectionKey(connection: ConnectionRecord) {
  const credentials = new MemoryCredentialStore()
  const ref = credentialRef('cred:v1:credential-tangle-seats')
  await credentials.store({
    ref,
    value: bindCredentialToOrigin(Buffer.from(KEY_CANARY), endpoint),
  })
  return {
    connection: { ...connection, credentialRef: createCredentialRefId('credential-tangle-seats') },
    credentials,
    credentialRefResolver: () => ref,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the seat proof')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

test('connection credential references accept names and refuse values with plain messages', () => {
  const accepted: ConnectionTransportOptions[] = [
    { secrets: [...GRANTED] },
    {
      secrets: ['GH_TOKEN'],
      modelCredentials: {
        command: ['acct', 'sandbox', 'resolve', '--key-env', 'DISCOVERY_SANDBOX_API_KEY'],
        env: ['ACCT_HOME'],
        connectionKeyEnv: 'DISCOVERY_SANDBOX_API_KEY',
        connectionEndpointEnv: 'DISCOVERY_SANDBOX_BASE_URL',
      },
    },
    {
      modelCredentials: {
        cliAuth: { account: 'drew@tangle.tools', secretEnv: 'CLAUDE_SEAT_1', format: 'token' },
      },
    },
  ]
  for (const options of accepted) {
    assert.doesNotThrow(() => assertConnectionRecord(record(options)))
    assert.doesNotThrow(() => new ConnectionRegistry([record(options)]))
  }

  const refused: ReadonlyArray<
    readonly [unknown, ConnectionRecord['kind'], 'SECRET' | 'INVALID', RegExp]
  > = [
    [{ secrets: { GH_TOKEN: VALUE_CANARY } }, 'tangle-sandbox', 'SECRET', /secret names; values/u],
    [{ secrets: [VALUE_CANARY] }, 'tangle-sandbox', 'SECRET', /contains credential material/u],
    [{ secrets: [] }, 'tangle-sandbox', 'INVALID', /at least one stored secret/u],
    [{ secrets: ['GH_TOKEN', 'GH_TOKEN'] }, 'tangle-sandbox', 'INVALID', /repeat a name/u],
    [{ secrets: ['gh token'] }, 'tangle-sandbox', 'INVALID', /environment-variable names/u],
    [{ secrets: ['GH_TOKEN'] }, 'cli-bridge', 'INVALID', /only for tangle-sandbox/u],
    [
      { modelCredentials: { command: ['acct'], apiKey: VALUE_CANARY } },
      'tangle-sandbox',
      'SECRET',
      /accepts only command/u,
    ],
    [
      { modelCredentials: { command: ['acct', `--token=${VALUE_CANARY}`] } },
      'tangle-sandbox',
      'SECRET',
      /command contains credential material/u,
    ],
    [
      { modelCredentials: { command: ['acct', VALUE_CANARY] } },
      'tangle-sandbox',
      'SECRET',
      /command contains credential material/u,
    ],
    [
      { modelCredentials: { command: ['acct'], env: { ACCT_HOME: VALUE_CANARY } } },
      'tangle-sandbox',
      'SECRET',
      /env must list variable names/u,
    ],
    [
      {
        modelCredentials: {
          cliAuth: { account: 'a', secretEnv: 'S', format: 'token', token: VALUE_CANARY },
        },
      },
      'tangle-sandbox',
      'SECRET',
      /cliAuth accepts only account, secretEnv and format/u,
    ],
    [
      { modelCredentials: { cliAuth: { account: 'a', secretEnv: VALUE_CANARY, format: 'token' } } },
      'tangle-sandbox',
      'SECRET',
      /secretEnv contains credential material/u,
    ],
    [
      { modelCredentials: { cliAuth: { account: 'a', secretEnv: 'S', format: 'raw' } } },
      'tangle-sandbox',
      'INVALID',
      /format must be token, bundle or files/u,
    ],
    [
      {
        modelCredentials: {
          command: ['acct'],
          cliAuth: { account: 'a', secretEnv: 'S', format: 'token' },
        },
      },
      'tangle-sandbox',
      'INVALID',
      /not both/u,
    ],
    [
      { modelCredentials: { command: ['acct'], env: ['K'], connectionKeyEnv: 'K' } },
      'tangle-sandbox',
      'INVALID',
      /exactly one source/u,
    ],
    [
      { modelCredentials: { command: [] } },
      'tangle-sandbox',
      'INVALID',
      /executable followed by its arguments/u,
    ],
    [
      { modelCredentials: `acct sandbox resolve --token=${VALUE_CANARY}` },
      'tangle-sandbox',
      'SECRET',
      /resolver command or a stored seat reference/u,
    ],
    [
      { modelCredentials: { command: ['acct'] } },
      'cli-bridge',
      'INVALID',
      /only for tangle-sandbox/u,
    ],
  ]
  for (const [options, kind, code, message] of refused) {
    const candidate = record(options as ConnectionTransportOptions, kind)
    assert.throws(
      () => new ConnectionRegistry([candidate]),
      (error: unknown) =>
        error instanceof ConnectionError &&
        error.code ===
          (code === 'SECRET' ? 'SECRET_IN_CONNECTION_RECORD' : 'INVALID_CONNECTION_RECORD') &&
        message.test(error.message) &&
        !error.message.includes(VALUE_CANARY),
      `${JSON.stringify(options).replaceAll(VALUE_CANARY, '<canary>')} must be refused`,
    )
    assert.throws(
      () => assertConnectionRecord(candidate),
      (error: unknown) =>
        error instanceof Error &&
        message.test(error.message) &&
        !error.message.includes(VALUE_CANARY),
    )
  }
})

test('saved connection references survive the journal, operation replay, and restart', async () => {
  const journal = new MemoryJournal(new FixedClock(at))
  const application = () =>
    createBraidApplication({
      fixture: 'deterministic',
      profile: DETERMINISTIC_PROFILE,
      clock: new FixedClock(at),
      journal,
      effectStorage: journal,
    })
  const service = (app: ReturnType<typeof application>) =>
    new ConnectionActionService({
      host: {
        state: () => app.state(),
        configuration: app.configuration,
        runtime: app.runtimeSelection,
      },
      now: () => at,
    })
  const options: ConnectionTransportOptions = {
    lifecycle: 'retained',
    idleTtlSeconds: 1_800,
    secrets: [...GRANTED],
    modelCredentials: {
      command: ['acct', 'sandbox', 'resolve'],
      env: ['ACCT_HOME'],
      connectionKeyEnv: 'DISCOVERY_SANDBOX_API_KEY',
      connectionEndpointEnv: 'DISCOVERY_SANDBOX_BASE_URL',
    },
  }
  const saved = record(options)
  const app = application()
  const created = await service(app).upsert({ operationId: 'operation-seat-save', record: saved })
  assert.equal(created.replayed, false)
  const journaled = app.events().find(({ event }) => event.kind === 'connection.upserted')?.event
  assert.ok(journaled?.kind === 'connection.upserted')
  assert.deepEqual(journaled.connection.providerOptions.secrets, GRANTED)
  assert.deepEqual(journaled.connection.providerOptions.modelCredentials, options.modelCredentials)
  assert.deepEqual(app.state().connections[0]?.providerOptions, saved.providerOptions)
  const replayed = await service(app).upsert({ operationId: 'operation-seat-save', record: saved })
  assert.equal(replayed.replayed, true)

  const restarted = application()
  assert.deepEqual(restarted.state().connections[0]?.providerOptions, saved.providerOptions)
  assert.equal(
    (await service(restarted).upsert({ operationId: 'operation-seat-save', record: saved }))
      .replayed,
    true,
  )

  // A record that fails validation never reaches the journal through the registry; if one did,
  // redaction still keeps its values out.
  const leaked = redactBraidEvent({
    kind: 'connection.upserted',
    connection: record({ secrets: { GH_TOKEN: VALUE_CANARY } } as never),
  })
  assert.doesNotMatch(JSON.stringify(leaked), new RegExp(VALUE_CANARY, 'u'))
})

test('stored and resolved seats reach the Tangle provider as references only', async () => {
  const sandbox = new FakeTangleRetainedSandbox({ backends: ['claude-code'] })
  const profile = subscriptionProfile('claude-code')
  const seat = { account: 'drew@tangle.tools', secretEnv: 'CLAUDE_SEAT_PROOF', format: 'token' }
  const staticProvider = await createTangleEnvironmentProvider(
    record({ modelCredentials: { cliAuth: seat } as never }),
    { sandboxClient: sandbox.client() },
  )
  await staticProvider.create({ profile, idempotencyKey: 'seat-static' })
  assert.deepEqual(sandbox.createCalls[0]?.secrets, ['CLAUDE_SEAT_PROOF'])
  assert.deepEqual(sandbox.createCalls[0]?.backend?.model, { cliAuth: seat, authMode: 'oauth' })

  const resolver = await resolverScript('cliAuth')
  const previous = process.env.BRAID_SEAT_FORWARDED
  process.env.BRAID_SEAT_FORWARDED = FORWARDED_CANARY
  try {
    const keyed = await storedConnectionKey(
      record({
        modelCredentials: {
          command: [process.execPath, resolver.path],
          env: ['BRAID_SEAT_FORWARDED'],
          connectionKeyEnv: 'BRAID_SEAT_CONNECTION_KEY',
        },
      }),
    )
    const provider = await createTangleEnvironmentProvider(keyed.connection, {
      credentials: keyed.credentials,
      credentialRefResolver: keyed.credentialRefResolver,
      sandboxClientFactory: () => sandbox.client(),
    })
    await provider.create({ profile, idempotencyKey: 'seat-resolved' })
    const seatName = `SEAT_${digest(KEY_CANARY)}`
    assert.deepEqual(sandbox.createCalls[1]?.secrets, [seatName])
    assert.deepEqual(sandbox.createCalls[1]?.backend?.model, {
      cliAuth: {
        account: `seat-${digest(FORWARDED_CANARY).toLowerCase()}`,
        secretEnv: seatName,
        format: 'token',
      },
      authMode: 'oauth',
    })
    const sent = JSON.stringify(sandbox.createCalls)
    for (const canary of [KEY_CANARY, FORWARDED_CANARY]) assert.equal(sent.includes(canary), false)

    delete process.env.BRAID_SEAT_FORWARDED
    await assert.rejects(
      provider.create({ profile, idempotencyKey: 'seat-missing-variable' }),
      (error: unknown) =>
        error instanceof ConnectionError &&
        error.code === 'CONNECTION_CREDENTIAL_REQUIRED' &&
        /needs BRAID_SEAT_FORWARDED set in Braid's environment/u.test(error.message),
    )
    assert.equal(sandbox.createCalls.length, 2)
  } finally {
    if (previous === undefined) delete process.env.BRAID_SEAT_FORWARDED
    else process.env.BRAID_SEAT_FORWARDED = previous
    await rm(resolver.directory, { recursive: true, force: true })
  }
})

test('retained and interactive environments bind the connection secret names into their identity', async () => {
  const sandbox = new FakeTangleRetainedSandbox()
  const base = record({ lifecycle: 'retained', idleTtlSeconds: 1_800 })
  const granted = record({ lifecycle: 'retained', idleTtlSeconds: 1_800, secrets: [...GRANTED] })
  const profile = defineAgentProfile({
    name: 'Retained grant proof',
    harness: 'opencode',
    model: { provider: 'openai', default: 'openai/gpt-5' },
  })
  const prepare = (connection: ConnectionRecord) =>
    resolveTangleSandboxRetainedConnection(
      {
        connections: new ConnectionRegistry([connection]),
        select: () => ({ connection: { connectionId: connection.id } }),
        sandboxClient: sandbox.client(),
      },
      {
        operationId: 'operation-retained-grants',
        runId: 'run/retained-grants',
        turnId: 'turn/retained-grants',
        text: 'Prove grants.',
        profile,
        connectionId: connection.id,
        signal: new AbortController().signal,
      },
      { connection: { connectionId: connection.id } },
      connection.id,
    )
  const without = await prepare(base)
  const prepared = await prepare(granted)
  assert.equal(without.secretNames, undefined)
  assert.deepEqual(prepared.secretNames, GRANTED)
  assert.notEqual(
    prepared.materializationReceipt.environmentRequestDigest,
    without.materializationReceipt.environmentRequestDigest,
  )
  assert.deepEqual(interactiveEnvironment(prepared, 'run/retained-grants').secrets, GRANTED)
  assert.equal('secrets' in interactiveEnvironment(without, 'run/retained-grants'), false)
  assert.equal(sandbox.createCalls.length, 0)
})

test('a cloud run with a resolver seat stores no secret value in the journal, state, or files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-seat-canary-'))
  const resolver = await resolverScript('apiKeyEnv')
  const sandbox = new FakeTangleRetainedSandbox()
  const profile = subscriptionProfile('opencode')
  const keyed = await storedConnectionKey(
    record({
      lifecycle: 'retained',
      idleTtlSeconds: 1_800,
      secrets: [...GRANTED],
      modelCredentials: {
        command: [process.execPath, resolver.path],
        env: ['BRAID_SEAT_FORWARDED'],
        connectionKeyEnv: 'BRAID_SEAT_CONNECTION_KEY',
        connectionEndpointEnv: 'BRAID_SEAT_ENDPOINT',
      },
    }),
  )
  const production = {
    profile,
    connections: [keyed.connection],
    connectionId: keyed.connection.id,
    connectionOptions: {
      credentials: keyed.credentials,
      credentialRefResolver: keyed.credentialRefResolver,
      sandboxClient: sandbox.client(),
    },
  }
  const previous = process.env.BRAID_SEAT_FORWARDED
  process.env.BRAID_SEAT_FORWARDED = FORWARDED_CANARY
  const path = join(root, 'braid.db')
  const credentialStore = new MemoryCredentialStore()
  let durable: DurableBraidApplication | undefined
  let reopened: DurableBraidApplication | undefined
  try {
    durable = await createDurableBraidApplication({
      path,
      workspaceRoot: root,
      credentialStore,
      production,
      ids: new RandomIds(),
    })
    durable.app.initialize(root)
    await durable.app.whenDurable()
    // The production binary journals the selected connection; encrypted storage must keep its names.
    await activateProductionConnection(durable.app, keyed.connection.id, [keyed.connection])
    const turn = durable.app.send({ operationId: 'operation-seat-canary', text: 'Use the seat.' })
    await turn.admissionReady
    await waitFor(() => sandbox.dispatches.length === 1)
    sandbox.complete(sandbox.dispatches[0]?.executionId ?? '', 'SEAT_PROOF_DONE')
    await turn.completion

    const seatName = `SEAT_${digest(KEY_CANARY)}`
    assert.deepEqual(sandbox.createCalls[0]?.secrets, [...GRANTED, seatName])
    assert.deepEqual(sandbox.createCalls[0]?.backend?.model, {
      apiKeyEnv: seatName,
      baseUrl: `${endpoint}/seat/${digest(FORWARDED_CANARY)}`,
    })
    assert.equal(durable.app.state().messages.at(-1)?.text, 'SEAT_PROOF_DONE')
    const canaries = [KEY_CANARY, FORWARDED_CANARY]
    const inMemory = JSON.stringify({
      events: durable.app.events(),
      state: durable.app.state(),
      sandbox: sandbox.createCalls,
    })
    for (const canary of canaries)
      assert.equal(inMemory.includes(canary), false, `canary of ${canary.length} characters`)
    await durable.app.close()
    await durable.storage.close()
    durable = undefined

    reopened = await createDurableBraidApplication({
      path,
      workspaceRoot: root,
      credentialStore,
      production,
      ids: new RandomIds(),
    })
    const persisted = JSON.stringify({
      events: reopened.app.events(),
      state: reopened.app.state(),
    })
    assert.equal(persisted.includes('SEAT_PROOF_DONE'), true)
    assert.deepEqual(
      reopened.app.state().connections[0]?.providerOptions,
      keyed.connection.providerOptions,
    )
    for (const canary of canaries)
      assert.equal(persisted.includes(canary), false, `canary of ${canary.length} characters`)
    await reopened.app.close()
    await reopened.storage.close()
    reopened = undefined
    await assertNoSecretArtifacts(root, canaries)
  } finally {
    if (previous === undefined) delete process.env.BRAID_SEAT_FORWARDED
    else process.env.BRAID_SEAT_FORWARDED = previous
    await durable?.app.close()
    await durable?.storage.close()
    await reopened?.app.close()
    await reopened?.storage.close()
    await rm(resolver.directory, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('retained intent recovery replays a subscription turn with the same profile material', async () => {
  const sandbox = new FakeTangleRetainedSandbox({ backends: ['claude-code'] })
  const resolver = await resolverScript('cliAuth')
  const previous = process.env.BRAID_SEAT_FORWARDED
  process.env.BRAID_SEAT_FORWARDED = FORWARDED_CANARY
  try {
    const keyed = await storedConnectionKey(
      record({
        lifecycle: 'retained',
        idleTtlSeconds: 1_800,
        secrets: [...GRANTED],
        modelCredentials: {
          command: [process.execPath, resolver.path],
          env: ['BRAID_SEAT_FORWARDED'],
          connectionKeyEnv: 'BRAID_SEAT_CONNECTION_KEY',
        },
      }),
    )
    const selection = { connection: { connectionId: keyed.connection.id } }
    const profile = subscriptionProfile('claude-code')
    const input = {
      operationId: 'operation-subscription-recovery',
      runId: 'run/subscription-recovery',
      turnId: 'turn/subscription-recovery',
      text: 'Use the seat after a crash.',
      profile,
      connectionId: keyed.connection.id,
      signal: new AbortController().signal,
    }
    const prepared = await resolveTangleSandboxRetainedConnection(
      {
        connections: new ConnectionRegistry([keyed.connection]),
        select: () => selection,
        credentials: keyed.credentials,
        credentialRefResolver: keyed.credentialRefResolver,
        sandboxClient: sandbox.client(),
      },
      input,
      selection,
      keyed.connection.id,
    )
    const plan = createProviderRetainedPlan(prepared, input.runId)
    const admissions: RetainedRunAdmissionRecord[] = []
    await assert.rejects(() =>
      startProviderRetainedRun(plan, {
        ...input,
        onRetainedAdmission: async (admission) => {
          admissions.push(admission)
          if (admission.phase === 'intent') throw new Error('simulated intent crash')
        },
      }),
    )
    const intent = admissions[0]
    assert.ok(intent?.phase === 'intent')
    assert.equal(sandbox.createCalls.length, 0)
    const receipt = createAdmissionReceipt({
      runId: input.runId,
      turnId: input.turnId,
      operationId: input.operationId,
      conversationId: 'conversation-subscription-recovery',
      branchId: 'branch-subscription-recovery',
      admittedAt: at,
      profile,
      connectionId: keyed.connection.id,
      capabilities: plan.capabilities,
      provider: plan.providerName,
      materializationReceipt: plan.materializationReceipt,
      text: input.text,
    })
    const recovering = createProviderRetainedPlan(prepared, input.runId, undefined, {
      retainedAdmission: intent,
      receipt,
    })
    assert.ok(
      await recovering.recover?.({
        admission: intent,
        receipt,
        onRetainedAdmission: async () => {},
      }),
    )
    assert.equal(sandbox.createCalls.length, 1)
    assert.equal(sandbox.dispatches.length, 1)
    assert.equal(sandbox.nativeGrants.length, 1)
  } finally {
    if (previous === undefined) delete process.env.BRAID_SEAT_FORWARDED
    else process.env.BRAID_SEAT_FORWARDED = previous
    await rm(resolver.directory, { recursive: true, force: true })
  }
})

test('a retained subscription turn carries its exact profile so the provider selects the turn seat', async () => {
  const sandbox = new FakeTangleRetainedSandbox({ backends: ['claude-code'] })
  const resolver = await resolverScript('cliAuth')
  const previous = process.env.BRAID_SEAT_FORWARDED
  process.env.BRAID_SEAT_FORWARDED = FORWARDED_CANARY
  try {
    const keyed = await storedConnectionKey(
      record({
        lifecycle: 'retained',
        idleTtlSeconds: 1_800,
        secrets: [...GRANTED],
        modelCredentials: {
          command: [process.execPath, resolver.path],
          env: ['BRAID_SEAT_FORWARDED'],
          connectionKeyEnv: 'BRAID_SEAT_CONNECTION_KEY',
        },
      }),
    )
    const selection = { connection: { connectionId: keyed.connection.id } }
    const input = {
      operationId: 'operation-subscription-turn',
      runId: 'run/subscription-turn',
      turnId: 'turn/subscription-turn',
      text: 'Use the seat.',
      profile: subscriptionProfile('claude-code'),
      connectionId: keyed.connection.id,
      signal: new AbortController().signal,
      onRetainedAdmission: async () => {},
    }
    const prepared = await resolveTangleSandboxRetainedConnection(
      {
        connections: new ConnectionRegistry([keyed.connection]),
        select: () => selection,
        credentials: keyed.credentials,
        credentialRefResolver: keyed.credentialRefResolver,
        sandboxClient: sandbox.client(),
      },
      input,
      selection,
      keyed.connection.id,
    )
    await startProviderRetainedRun(createProviderRetainedPlan(prepared, input.runId), input)

    const seatName = `SEAT_${digest(KEY_CANARY)}`
    const seat = {
      account: `seat-${digest(FORWARDED_CANARY).toLowerCase()}`,
      secretEnv: seatName,
      format: 'token',
    }
    assert.equal(sandbox.createCalls.length, 1)
    assert.deepEqual(sandbox.createCalls[0]?.secrets, [...GRANTED, seatName])
    assert.deepEqual(sandbox.createCalls[0]?.backend?.model, { cliAuth: seat, authMode: 'oauth' })
    assert.equal(sandbox.dispatches.length, 1)
    assert.deepEqual(sandbox.nativeGrants, [{ harness: 'claude-code', cliAuth: seat }])
    const sent = JSON.stringify({ creates: sandbox.createCalls, grants: sandbox.nativeGrants })
    for (const canary of [KEY_CANARY, FORWARDED_CANARY]) assert.equal(sent.includes(canary), false)
  } finally {
    if (previous === undefined) delete process.env.BRAID_SEAT_FORWARDED
    else process.env.BRAID_SEAT_FORWARDED = previous
    await rm(resolver.directory, { recursive: true, force: true })
  }
})
