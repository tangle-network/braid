import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  type AgentEnvironmentCapabilities,
  type AgentProfile,
  type HarnessType,
  defineAgentProfile,
} from '@tangle-network/agent-interface'
import {
  admissionOperationDigest,
  completeAdmission,
  ConnectionController,
  type ConnectionProviderPort,
  type ConnectionRecord,
  ConnectionRegistry,
  type CredentialReference,
  type CredentialStore,
  canonicalDigest,
  canonicalJson,
  containedWorkspacePath,
  createConnectionRecord,
  createCliBridgeProvider,
  discoverProfiles,
  FetchConnectionHttpTransport,
  failAdmission,
  JsonAdmissionLedger,
  JsonConnectionRecordPersistence,
  MemoryReceiptStore,
  openProfileEditor,
  pointerParts,
  profileDocumentFromJson,
  profileSchemaIdentity,
  ProfileSourceRegistry,
  ProviderContentTypeError,
  ProviderHttpStatusError,
  ProviderOriginError,
  ProviderPayloadError,
  ProviderRedirectError,
  ProviderResponseTooLargeError,
  ProviderRequestTimeoutError,
  ProviderRequestTooLargeError,
  readCapabilitySnapshot,
  redactErrorMessage,
  redactProviderText,
  redactProviderValue,
  resolveProviderUrl,
  resolveWorkspaceRoot,
  reserveAdmission,
  RunAdmissionController,
  selectProfileReference,
  setAtProfilePointer,
  type ConnectionCapabilitySnapshot,
  type ConnectionHealth,
  MemoryAdmissionLedger,
  materializationReceiptDigest,
  unsupportedProfileDimensions,
  validateProviderOptions,
  WorkspacePathEscapeError,
} from '../src/index.js'

const profile: AgentProfile = defineAgentProfile({
  name: 'boundary fixture',
  model: { default: 'anthropic/claude-sonnet-4-5' },
  harness: 'claude-code',
})

const environment: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: true,
    systemPrompt: true,
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: {
      files: true,
      instructions: true,
      tools: true,
      skills: true,
      agents: true,
      commands: true,
    },
    hooks: true,
    modes: true,
    runtimeUpdate: false,
    validation: true,
    extensions: [],
  },
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, list: true, messages: true },
  workspace: { read: true, write: true, exec: true, git: true, upload: true, download: true },
  branching: { checkpoint: true, fork: true },
  placement: true,
  usage: true,
  confidential: true,
}

const capabilities: ConnectionCapabilitySnapshot = Object.freeze({
  environment,
  supportedRunners: ['claude-code' as HarnessType],
  modelIds: ['anthropic/claude-sonnet-4-5'],
  modelReasoning: {},
  retrievedAt: new Date(0).toISOString(),
  source: 'boundary-test',
})

const provider: ConnectionProviderPort = {
  kind: 'cli-bridge',
  async health(): Promise<ConnectionHealth> {
    return { status: 'healthy', checkedAt: new Date(0).toISOString() }
  },
  async capabilities(): Promise<ConnectionCapabilitySnapshot> {
    return capabilities
  },
}

function connection(
  overrides: {
    readonly id?: string
    readonly name?: string
    readonly endpoint?: string
    readonly credentialRef?: CredentialReference
  } = {},
): ConnectionRecord {
  return createConnectionRecord({
    id: overrides.id ?? 'bridge',
    kind: 'cli-bridge',
    name: overrides.name ?? 'bridge',
    endpoint: overrides.endpoint ?? 'http://127.0.0.1:7331',
    ...(overrides.credentialRef === undefined ? {} : { credentialRef: overrides.credentialRef }),
    now: new Date(0).toISOString(),
  })
}

function response(body: string, status = 200, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

test('canonical JSON and digests use one RFC 8785 representation', () => {
  const left = canonicalJson({ b: 2, a: 1, omitted: undefined })
  const right = canonicalJson({ a: 1, b: 2 })
  assert.equal(left, '{"a":1,"b":2}')
  assert.equal(left, right)
  assert.equal(
    canonicalJson(JSON.parse('{"__proto__":{"safe":true}}')),
    '{"__proto__":{"safe":true}}',
  )
  assert.equal(
    canonicalDigest({ b: 2, a: 1 }),
    `sha256:${createHash('sha256').update(left).digest('hex')}`,
  )
  assert.throws(() => canonicalJson([undefined]), /cannot be undefined/u)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(() => canonicalDigest(cyclic), /acyclic/u)
  assert.throws(() => canonicalJson(new Date()), /plain JSON object/u)
})

test('JSON Pointer escaping addresses slash and tilde keys without prototype access', () => {
  const initial = { 'a/b~c': { enabled: false } }
  const pointer = '/a~1b~0c/enabled'
  assert.deepEqual(pointerParts(pointer), ['a/b~c', 'enabled'])
  const changed = setAtProfilePointer(initial, pointer, true) as typeof initial
  assert.equal(changed['a/b~c'].enabled, true)
  assert.equal(Object.hasOwn({}, 'enabled'), false)
  assert.throws(() => pointerParts('/a~2b'), /Invalid escape/u)
  assert.throws(() => setAtProfilePointer({ x: [1] }, '/x/01', 2), /Missing profile array path/u)
  const protectedWrite = setAtProfilePointer({}, '/__proto__/polluted', true) as Record<
    string,
    unknown
  >
  const protectedValue = Object.getOwnPropertyDescriptor(protectedWrite, '__proto__')?.value as
    | Record<string, unknown>
    | undefined
  assert.equal(protectedValue?.polluted, true)
  assert.equal(Object.getPrototypeOf(protectedWrite), null)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
  const metadata = setAtProfilePointer(
    { constructor: { own: true }, prototype: { own: true } },
    '/constructor/own',
    false,
  ) as Record<string, unknown>
  const constructorMetadata = Object.getOwnPropertyDescriptor(metadata, 'constructor')?.value as
    | Record<string, boolean>
    | undefined
  const prototypeMetadata = Object.getOwnPropertyDescriptor(metadata, 'prototype')?.value as
    | Record<string, boolean>
    | undefined
  assert.equal(constructorMetadata?.own, false)
  assert.equal(prototypeMetadata?.own, true)
})

test('pointer intake bounds programmatic replacements before cloning', () => {
  assert.throws(
    () =>
      setAtProfilePointer(
        {},
        '/items',
        Array.from({ length: 20_001 }, () => 'x'),
      ),
    /more than 20000 entries/u,
  )
  assert.throws(
    () => setAtProfilePointer({}, '/text', 'x'.repeat(262_145)),
    /exceeds 262144 characters/u,
  )
})

test('schema identity and unknown-field policy distinguish readable skew from invalid nesting', () => {
  const schema = profileSchemaIdentity()
  assert.deepEqual(schema, {
    package: '@tangle-network/agent-interface',
    version: schema.version,
    digestAlgorithm: 'sha256',
    serialization: 'rfc8785',
  })
  const source = {
    kind: 'local-file' as const,
    value: '/tmp/profile.json',
    label: 'profile.json',
    writable: true,
  }
  const unknown = profileDocumentFromJson(
    '{"name":"boundary fixture","model":{"default":"anthropic/claude-sonnet-4-5"},"harness":"claude-code","futureField":{"x":true}}',
    source,
  )
  assert.equal(unknown.saveBlock, 'unrecognized-fields')
  assert.equal(unknown.writable, false)
  assert.deepEqual(unknown.unrecognizedFields, ['futureField'])
  assert.equal(unknown.rawJson.includes('futureField'), true)
  assert.throws(
    () =>
      profileDocumentFromJson(
        '{"name":"boundary fixture","model":{"default":"anthropic/claude-sonnet-4-5","future":true},"harness":"claude-code"}',
        source,
      ),
    /Cannot import profile/u,
  )
  assert.throws(() => profileDocumentFromJson('{"name":"a","name":"b"}', source), /duplicate key/u)
  assert.equal(openProfileEditor(unknown).rawJson, unknown.rawJson)
})

test('workspace paths reject relative traversal and every symlink component', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-boundary-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'braid-boundary-outside-'))
  const parent = await mkdtemp(join(tmpdir(), 'braid-boundary-parent-'))
  try {
    await mkdir(join(root, 'safe'))
    await writeFile(join(outside, 'outside.json'), '{}')
    await symlink(outside, join(root, 'safe', 'link'))
    await symlink(join(outside, 'outside.json'), join(root, 'final.json'))
    await assert.rejects(
      containedWorkspacePath(root, 'safe/missing.json'),
      WorkspacePathEscapeError,
    )
    await assert.rejects(
      containedWorkspacePath(root, join(root, '..', 'braid-boundary-outside-escape')),
      WorkspacePathEscapeError,
    )
    await assert.rejects(
      containedWorkspacePath(root, join(root, 'safe', 'link', 'outside.json')),
      /symbolic link/u,
    )
    await assert.rejects(containedWorkspacePath(root, join(root, 'final.json')), /symbolic link/u)
    const missing = await containedWorkspacePath(root, join(root, 'safe', 'missing.json'))
    assert.equal(missing.relativePath, 'safe/missing.json')
    await symlink(root, join(parent, 'root-link'))
    await assert.rejects(resolveWorkspaceRoot(join(parent, 'root-link')), /symbolic link/u)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

test('redaction covers exact credentials, secret-shaped values, and object errors', () => {
  const secret = 'boundary-secret-opaque-123'
  const controlledSecret = 'boundary\u001b-secret-opaque-456'
  assert.equal(
    redactProviderText(`provider echoed ${secret}`, 512, [secret])?.includes(secret),
    false,
  )
  assert.equal(
    JSON.stringify(
      redactProviderValue({ message: secret, nested: `Bearer ${secret}` }, 0, [secret]),
    ).includes(secret),
    false,
  )
  assert.equal(redactErrorMessage({ message: secret }, [secret]).includes(secret), false)
  assert.equal(
    redactProviderText(`provider echoed ${controlledSecret}`, 512, [controlledSecret])?.includes(
      controlledSecret,
    ),
    false,
  )
})

test('provider bearer values never reach payloads, versions, or transport errors', async () => {
  const secret = 'boundary-bearer-opaque-789'
  const record = connection({ credentialRef: { kind: 'os', id: 'bearer' } })
  const credentials: CredentialStore = {
    async store() {
      return { kind: 'os', id: 'bearer' }
    },
    async resolve() {
      return { use: async <T>(operation: (value: string) => Promise<T>) => operation(secret) }
    },
    async remove() {},
  }
  const echoed = new FetchConnectionHttpTransport({
    credentials,
    fetchImpl: (async (_input, init) => {
      if (init?.headers === undefined) throw new Error('missing request headers')
      const authorization = (init.headers as Record<string, string>).authorization
      return new Response(JSON.stringify({ authorization, nested: { token: secret } }), {
        headers: { 'content-type': 'application/json', 'x-provider-version': secret },
      })
    }) as typeof fetch,
  })
  const result = await echoed.request({ connection: record, path: '/health', method: 'GET' })
  assert.equal(JSON.stringify(result).includes(secret), false)
  const failed = new FetchConnectionHttpTransport({
    credentials,
    fetchImpl: (async () => {
      throw new Error(`provider failed with ${secret}`)
    }) as typeof fetch,
  })
  await assert.rejects(
    failed.request({ connection: record, path: '/health', method: 'GET' }),
    (error: unknown) => !String(error).includes(secret),
  )
})

test('connection records persist, restore, and release only exclusively owned OS credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-connection-store-'))
  try {
    const path = join(directory, 'connections.json')
    const persistence = new JsonConnectionRecordPersistence(path)
    const shared = { kind: 'os' as const, id: 'shared' }
    const removed: string[] = []
    const credentials: CredentialStore = {
      async store() {
        return shared
      },
      async resolve() {
        return { use: async <T>(operation: (value: string) => Promise<T>) => operation('secret') }
      },
      async remove(reference) {
        removed.push(reference.id)
      },
    }
    const controller = new ConnectionController({
      registry: new ConnectionRegistry(),
      providers: [provider],
      credentials,
      persistence,
      now: () => new Date(0).toISOString(),
    })
    await controller.setup({
      id: 'one',
      kind: 'cli-bridge',
      name: 'one',
      endpoint: 'http://127.0.0.1:7331',
      credentialRef: shared,
      now: new Date(0).toISOString(),
    })
    await controller.setup({
      id: 'two',
      kind: 'cli-bridge',
      name: 'two',
      endpoint: 'http://127.0.0.1:7331',
      credentialRef: shared,
      now: new Date(0).toISOString(),
    })
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await readFile(path, 'utf8')).includes('secret'), false)
    const restarted = new ConnectionController({
      registry: new ConnectionRegistry(),
      providers: [provider],
      credentials,
      persistence,
      now: () => new Date(0).toISOString(),
    })
    assert.deepEqual(
      (await restarted.restore()).map((entry) => entry.id),
      ['one', 'two'],
    )
    const usage = {
      activeRuns: [],
      detachedRuns: [],
      environments: [],
      credentialReferences: [],
    }
    await restarted.remove('one', usage)
    assert.deepEqual(removed, [])
    await restarted.remove('two', usage)
    assert.deepEqual(removed, ['shared'])
    assert.deepEqual(await persistence.load(), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('HTTP transport blocks redirects, wrong content, oversized bodies, and timeouts', async () => {
  const record = connection()
  const make = (body: string, status = 200, contentType = 'application/json', limits = {}) =>
    new FetchConnectionHttpTransport({
      limits,
      fetchImpl: (async () => response(body, status, contentType)) as typeof fetch,
    })
  await assert.rejects(
    make('not json', 200, 'text/plain').request({
      connection: record,
      path: '/health',
      method: 'GET',
    }),
    ProviderContentTypeError,
  )
  await assert.rejects(
    make('{bad').request({ connection: record, path: '/health', method: 'GET' }),
    ProviderPayloadError,
  )
  await assert.rejects(
    make('{}', 302).request({ connection: record, path: '/health', method: 'GET' }),
    ProviderRedirectError,
  )
  await assert.rejects(
    make('12345', 200, 'application/json', { maxResponseBytes: 4 }).request({
      connection: record,
      path: '/health',
      method: 'GET',
    }),
    /exceeded 4 bytes/u,
  )
  await assert.rejects(
    make('{}', 200, 'application/json', { maxRequestBytes: 4 }).request({
      connection: record,
      path: '/health',
      method: 'POST',
      body: { value: 'éé' },
    }),
    ProviderRequestTooLargeError,
  )
  await assert.rejects(
    new FetchConnectionHttpTransport({
      fetchImpl: (async () => {
        throw new TypeError('fetch failed because redirect mode is error')
      }) as typeof fetch,
    }).request({ connection: record, path: '/health', method: 'GET' }),
    ProviderRedirectError,
  )
  const timedOut = new FetchConnectionHttpTransport({
    limits: { timeoutMs: 5 },
    fetchImpl: (async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof fetch,
  })
  await assert.rejects(
    timedOut.request({ connection: record, path: '/health', method: 'GET' }),
    ProviderRequestTimeoutError,
  )
  const hangingBody = new FetchConnectionHttpTransport({
    limits: { timeoutMs: 5 },
    fetchImpl: (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
  })
  await assert.rejects(
    hangingBody.request({ connection: record, path: '/health', method: 'GET' }),
    ProviderRequestTimeoutError,
  )
  assert.throws(() => resolveProviderUrl(record.endpoint as string, 'https://evil.example/x'))
  assert.throws(() => resolveProviderUrl(record.endpoint as string, '/health?token=secret'))
  assert.throws(
    () => resolveProviderUrl(record.endpoint as string, '/health/%E0%A4%A'),
    ProviderOriginError,
  )
  await assert.rejects(
    make('12345', 200, 'application/json', { maxResponseBytes: 4 }).request({
      connection: record,
      path: '/health',
      method: 'GET',
    }),
    ProviderResponseTooLargeError,
  )
})

test('HTTP status and provider capability validation fail closed', async () => {
  const record = connection()
  assert.throws(
    () =>
      createConnectionRecord({
        id: 'missing-endpoint',
        kind: 'cli-bridge',
        name: 'missing endpoint',
        now: new Date(0).toISOString(),
      }),
    /require an endpoint/u,
  )
  const transport = new FetchConnectionHttpTransport({
    fetchImpl: (async () => response('{"error":"no"}', 503)) as typeof fetch,
  })
  await assert.rejects(
    createCliBridgeProvider(transport).capabilities(record),
    ProviderHttpStatusError,
  )
  assert.throws(
    () =>
      readCapabilitySnapshot(
        {
          environment,
          runners: ['claude-code', 'claude-code'],
          models: ['m'],
        },
        new Date(0).toISOString(),
        'provider',
      ),
    /duplicate runner/u,
  )
  assert.throws(
    () =>
      readCapabilitySnapshot(
        {
          environment,
          runners: ['not-a-runner'],
          models: ['m'],
        },
        new Date(0).toISOString(),
        'provider',
      ),
    /unknown runner/u,
  )
  assert.deepEqual(
    unsupportedProfileDimensions(
      { ...environment.profile, tools: false },
      { ...profile, tools: { read: true } },
    ),
    ['tools'],
  )
  const limitedProvider: ConnectionProviderPort = {
    ...provider,
    async capabilities() {
      return {
        ...capabilities,
        environment: {
          ...capabilities.environment,
          profile: { ...capabilities.environment.profile, tools: false },
        },
      }
    },
  }
  const limitedRegistry = new ConnectionRegistry()
  limitedRegistry.save(record)
  const controller = new ConnectionController({
    registry: limitedRegistry,
    providers: [limitedProvider],
    now: () => new Date(0).toISOString(),
  })
  const checked = await controller.validateProfile('bridge', { ...profile, tools: { read: true } })
  assert.equal(checked.ok, false)
  assert.equal(checked.issues[0]?.code, 'UNSUPPORTED_PROFILE_DIMENSION')
  assert.throws(
    () =>
      validateProviderOptions('tangle-inference', {
        routerBaseUrl: 'https://user:pass@example.com',
      }),
    /credentials/u,
  )
})

test('profile-source precedence and admission reservations fail closed under races', async () => {
  assert.deepEqual(selectProfileReference({ explicit: '', user: 'user-profile' }), {
    reference: '',
    source: 'command-line',
  })
  assert.deepEqual(selectProfileReference({ branch: 'branch', user: 'user-profile' }), {
    reference: 'branch',
    source: 'branch',
  })
  assert.deepEqual(
    selectProfileReference({ trustedWorkspace: 'workspace', user: 'user-profile' }),
    { reference: 'workspace', source: 'workspace' },
  )
  assert.deepEqual(selectProfileReference({ user: 'user-profile', firstRun: 'first' }), {
    reference: 'user-profile',
    source: 'user',
  })
  assert.deepEqual(selectProfileReference({ firstRun: 'first' }), {
    reference: 'first',
    source: 'first-run',
  })
  const explicitDiscovery = await discoverProfiles(
    { explicitReference: '', userReferences: ['inline:{"name":"fallback"}'] },
    new ProfileSourceRegistry(),
  )
  assert.deepEqual(
    explicitDiscovery.map((entry) => entry.reference),
    [''],
  )
  const digest = admissionOperationDigest({
    identifiers: { operationId: 'race-op' },
    authoredProfileDigest: canonicalDigest(profile),
    effectiveProfileDigest: canonicalDigest(profile),
    connectionIdentityDigest: canonicalDigest(connection()),
    selectionDigest: canonicalDigest({ runner: 'claude-code' }),
    workspaceDigest: canonicalDigest({}),
  })
  const directory = await mkdtemp(join(tmpdir(), 'braid-ledger-'))
  const path = join(directory, 'ledger.json')
  const ledger = new JsonAdmissionLedger(path)
  const competingLedger = new JsonAdmissionLedger(path)
  try {
    const [first, second] = await Promise.allSettled([
      reserveAdmission(ledger, {
        operationId: 'race-op',
        operationDigest: digest,
        now: new Date(0).toISOString(),
      }),
      reserveAdmission(competingLedger, {
        operationId: 'race-op',
        operationDigest: digest,
        now: new Date(0).toISOString(),
      }),
    ])
    assert.equal([first, second].filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal([first, second].filter((result) => result.status === 'rejected').length, 1)
    await completeAdmission(ledger, {
      operationId: 'race-op',
      operationDigest: digest,
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      receiptDigest: `sha256:${'c'.repeat(64)}`,
    })
    const restarted = new JsonAdmissionLedger(path)
    assert.equal((await restarted.read('race-op'))?.state, 'materialized')
    const failedLedger = new MemoryAdmissionLedger()
    const failureDigest = admissionOperationDigest({
      identifiers: { operationId: 'failure-op' },
      authoredProfileDigest: canonicalDigest(profile),
      effectiveProfileDigest: canonicalDigest(profile),
      connectionIdentityDigest: canonicalDigest(connection()),
      selectionDigest: canonicalDigest({ runner: 'claude-code' }),
      workspaceDigest: canonicalDigest({}),
    })
    assert.deepEqual(
      await reserveAdmission(failedLedger, {
        operationId: 'failure-op',
        operationDigest: failureDigest,
        now: new Date(0).toISOString(),
      }),
      {},
    )
    await failAdmission(failedLedger, {
      operationId: 'failure-op',
      operationDigest: failureDigest,
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      failure: 'provider echoed Bearer boundary-secret-opaque-123',
    })
    assert.equal(
      (await failedLedger.read('failure-op'))?.failure?.includes('boundary-secret'),
      false,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('admission retries replay a durable receipt after a controller restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-admission-restart-'))
  try {
    const source = profileDocumentFromJson(JSON.stringify(profile), {
      kind: 'inline',
      value: 'inline',
      label: 'inline profile',
      writable: true,
    })
    const receipts = new MemoryReceiptStore()
    const ledgerPath = join(directory, 'admissions.json')
    let dispatches = 0
    const runtime = {
      async confirmCapabilities() {},
      async admit(input: {
        readonly requestDigest: string
        readonly effectiveProfileDigest: string
        readonly capabilityDigest: string
      }) {
        dispatches += 1
        const body = {
          requestDigest: input.requestDigest,
          effectiveProfileDigest: input.effectiveProfileDigest,
          capabilityDigest: input.capabilityDigest,
          generatedPaths: [],
          unsupportedDimensions: [],
          normalizedValues: {},
        } as const
        return { materializationDigest: materializationReceiptDigest(body), ...body }
      },
    }
    const identifiers = {
      operationId: 'restart-operation',
      turnId: 'restart-turn',
      branchId: 'restart-branch',
      conversationId: 'restart-conversation',
    }
    const first = new RunAdmissionController({
      provider,
      runtime,
      receipts,
      ledger: new JsonAdmissionLedger(ledgerPath),
      now: () => new Date(0).toISOString(),
    })
    const prepared = await first.prepare({ identifiers, source, connection: connection() })
    const original = await first.admit({ prepared })
    const restarted = new RunAdmissionController({
      provider,
      runtime,
      receipts,
      ledger: new JsonAdmissionLedger(ledgerPath),
      now: () => new Date(0).toISOString(),
    })
    const replay = await restarted.admit({ prepared })
    assert.equal(dispatches, 1)
    assert.equal(
      replay.postMaterialization?.receiptDigest,
      original.postMaterialization?.receiptDigest,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
