import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  type AgentEnvironmentCapabilities,
  type AgentProfile,
  defineAgentProfile,
  defineAgentProfileSecretRef,
} from '@tangle-network/agent-interface'
import {
  buildStructuredProfileView,
  type ConnectionCapabilitySnapshot,
  ConnectionController,
  type ConnectionHealth,
  type ConnectionHttpResponse,
  type ConnectionHttpTransport,
  type ConnectionProviderPort,
  type ConnectionRecord,
  ConnectionRegistry,
  type CredentialReference,
  createCliBridgeProvider,
  createConnectionRecord,
  createTangleInferenceProvider,
  createTangleSandboxProvider,
  discoverProfiles,
  EnvironmentCredentialStore,
  FetchConnectionHttpTransport,
  editRawProfile,
  editStructuredProfile,
  exportProfileAtomically,
  exportProfile,
  FirstRunController,
  inspectWorkspaceTrust,
  MemoryReceiptStore,
  materializationReceiptDigest,
  openProfileEditor,
  type ProfileDocument,
  ProfileSourceRegistry,
  profileDocumentFromJson,
  RunAdmissionController,
  type RunnerCapabilityCatalog,
  resolveEffectiveRun,
  saveProfileAtomically,
  selectProfileReference,
  validateCanonicalProfile,
  WorkspaceTrustStore,
} from '../src/index.js'

const securityPolicy = {
  allowLocalMcp: true,
  allowHooks: true,
  allowedMcpHosts: ['mcp.example.com'],
}

const profile = defineAgentProfile({
  name: 'W7 profile',
  description: 'All canonical profile surfaces',
  version: '1.0.0',
  tags: ['w7', 'portable'],
  prompt: {
    systemPrompt: 'You are a careful coding agent.',
    instructions: ['Keep changes reviewable.'],
  },
  model: {
    default: 'anthropic/claude-sonnet-4-5',
    small: 'anthropic/claude-haiku-4-5',
    provider: 'anthropic',
    reasoningEffort: 'high',
    metadata: { source: 'test' },
  },
  harness: 'claude-code',
  permissions: { read: 'allow', shell: { 'git status': 'ask' } },
  tools: { read: true, shell: false },
  mcp: {
    remote: {
      transport: 'http',
      url: 'https://mcp.example.com/tools',
      headers: { Authorization: defineAgentProfileSecretRef('MCP_TOKEN', 'bearer') },
      metadata: { owner: 'test' },
    },
    disabled: { enabled: false, metadata: { reason: 'fixture' } },
  },
  connections: [{ connectionId: 'hub-github', capabilities: ['repo.read'], alias: 'github' }],
  subagents: {
    reviewer: {
      description: 'Reviews changes',
      prompt: 'Review the patch.',
      model: 'anthropic/claude-sonnet-4-5',
      tools: { read: true },
      permissions: { read: 'allow' },
      maxSteps: 4,
      metadata: { role: 'review' },
    },
  },
  resources: {
    files: [
      {
        path: 'AGENTS.md',
        resource: { kind: 'inline', name: 'instructions', content: 'Be precise.' },
        executable: false,
      },
    ],
    tools: [{ kind: 'inline', name: 'tool', content: '{}' }],
    skills: [
      {
        kind: 'github',
        repository: 'tangle-network/agent-sdk',
        path: 'SKILL.md',
        ref: 'main',
        name: 'skill',
      },
    ],
    agents: [{ kind: 'inline', name: 'agent', content: '{}' }],
    commands: [{ kind: 'inline', name: 'command', content: '{}' }],
    instructions: { kind: 'inline', name: 'extra', content: 'Extra.' },
    failOnError: true,
  },
  hooks: {
    before: [
      {
        command: 'git status',
        timeoutMs: 1000,
        blocking: true,
        matcher: '*',
        env: { TOKEN: defineAgentProfileSecretRef('HOOK_TOKEN') },
      },
    ],
  },
  modes: {
    review: {
      description: 'Review mode',
      model: 'anthropic/claude-sonnet-4-5',
      prompt: 'Review.',
      tools: { read: true },
      permissions: { read: 'allow' },
      metadata: { color: 'blue' },
    },
  },
  confidential: {
    tee: 'any',
    attestationNonce: '00'.repeat(32),
    sealed: true,
    attestationRefresh: true,
  },
  metadata: { team: 'braid', nested: { enabled: true } },
  extensions: {
    'x-example.backend': { flag: true, values: ['one', 'two'] },
    'vendor.example': { mode: 'safe' },
  },
})

function documentFor(value: AgentProfile = profile): ProfileDocument {
  const rawJson = JSON.stringify(value, null, 2)
  return profileDocumentFromJson(
    rawJson,
    { kind: 'local-file', value: '/tmp/profile.json', label: 'profile.json', writable: true },
    value === profile ? { securityPolicy } : {},
  )
}

const admissionProfile = defineAgentProfile({
  name: 'Admission profile',
  prompt: { systemPrompt: 'Run the deterministic admission fixture.' },
  model: { default: 'anthropic/claude-sonnet-4-5', reasoningEffort: 'high' },
  harness: 'claude-code',
})

const catalog: RunnerCapabilityCatalog = {
  supportedRunners: ['claude-code', 'codex', 'opencode'],
  modelIds: ['anthropic/claude-sonnet-4-5', 'anthropic/claude-opus-4-1', 'openai/gpt-5'],
  modelReasoning: {
    'anthropic/claude-sonnet-4-5': { supportsReasoning: true, maxEffort: 'high' },
    'anthropic/claude-opus-4-1': { supportsReasoning: true, maxEffort: 'ultracode' },
    'openai/gpt-5': { supportsReasoning: true, maxEffort: 'xhigh' },
  },
}

function capabilities(): ConnectionCapabilitySnapshot {
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
      extensions: ['x-example.backend', 'vendor.example'],
    },
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    sessions: { continue: true, list: true, messages: true },
    workspace: { read: true, write: true, exec: true, git: true, upload: true, download: true },
    branching: { checkpoint: true, fork: true },
    placement: true,
    usage: true,
    confidential: true,
  }
  return Object.freeze({
    environment,
    ...catalog,
    retrievedAt: new Date(0).toISOString(),
    source: 'deterministic',
  })
}

const deterministicProvider: ConnectionProviderPort = {
  kind: 'cli-bridge',
  async health(): Promise<ConnectionHealth> {
    return { status: 'healthy', checkedAt: new Date(0).toISOString() }
  },
  async capabilities() {
    return capabilities()
  },
  async validateProfile(_connection, candidate) {
    return {
      ok: true,
      normalizedProfile: candidate,
      issues: [
        {
          level: 'warning',
          code: 'NORMALIZED_MODEL',
          message: 'Provider will normalize the model',
        },
      ],
    }
  },
}

function connection(): ConnectionRecord {
  return createConnectionRecord({
    id: 'bridge-local',
    kind: 'cli-bridge',
    name: 'Local bridge',
    endpoint: 'http://127.0.0.1:7331',
    now: new Date(0).toISOString(),
  })
}

function receipt(
  input: {
    readonly requestDigest: string
    readonly effectiveProfileDigest: string
    readonly capabilityDigest: string
  },
  extras: {
    readonly generatedPaths?: readonly { readonly path: string; readonly mode?: number }[]
    readonly unsupportedDimensions?: readonly string[]
    readonly normalizedValues?: Readonly<Record<string, unknown>>
    readonly runtimeRunId?: string
    readonly providerSessionId?: string
    readonly environmentId?: string
    readonly placement?: Readonly<Record<string, unknown>>
  } = {},
) {
  const body = {
    requestDigest: input.requestDigest,
    effectiveProfileDigest: input.effectiveProfileDigest,
    capabilityDigest: input.capabilityDigest,
    generatedPaths: extras.generatedPaths ?? [],
    unsupportedDimensions: extras.unsupportedDimensions ?? [],
    normalizedValues: extras.normalizedValues ?? {},
    ...(extras.runtimeRunId === undefined ? {} : { runtimeRunId: extras.runtimeRunId }),
    ...(extras.providerSessionId === undefined
      ? {}
      : { providerSessionId: extras.providerSessionId }),
    ...(extras.environmentId === undefined ? {} : { environmentId: extras.environmentId }),
    ...(extras.placement === undefined ? {} : { placement: extras.placement }),
  } as const
  return { materializationDigest: materializationReceiptDigest(body), ...body }
}

test('PC-01 structured and raw editor round-trip every installed canonical field', () => {
  const document = documentFor()
  const editor = openProfileEditor(document, { securityPolicy })
  const edited = editRawProfile(editor, editor.rawJson)
  assert.deepEqual(edited.profile, profile)
  const structuredEdited = editStructuredProfile(edited, '/metadata/nested/enabled', false)
  assert.equal(
    (structuredEdited.profile?.metadata as { readonly nested?: { readonly enabled?: boolean } })
      ?.nested?.enabled,
    false,
  )
  const structured = buildStructuredProfileView(edited)
  assert.ok(structured.entries.some((entry) => entry.path === '/extensions/x-example.backend'))
  assert.ok(
    structured.entries.some((entry) => entry.path === '/resources/files/0/resource/content'),
  )
  assert.throws(() => {
    ;(structured.entries[0]?.value as Record<string, unknown>).name = 'changed'
  }, TypeError)
})

test('PC-02 preserves extension namespaces and blocks unknown non-canonical fields', () => {
  const parsed = validateCanonicalProfile(
    { ...profile, extensions: { 'new.backend': { retained: true } } },
    { securityPolicy },
  )
  assert.equal(parsed.ok, true)
  assert.ok(parsed.profile)
  assert.equal(
    (parsed.profile.extensions as Record<string, unknown>)['new.backend'] !== undefined,
    true,
  )
  const unknown = validateCanonicalProfile(
    { ...profile, futureCanonicalField: true },
    { securityPolicy },
  )
  assert.equal(unknown.ok, false)
  assert.ok(unknown.issues.some((issue) => issue.code === 'UNRECOGNIZED_PROFILE_FIELD'))
})

test('PC-03 applies exact profile and run override precedence', () => {
  assert.deepEqual(
    selectProfileReference({
      explicit: 'cli',
      branch: 'branch',
      trustedWorkspace: 'workspace',
      user: 'user',
      firstRun: 'first',
    }),
    { reference: 'cli', source: 'command-line' },
  )
  const selection = resolveEffectiveRun(
    profile,
    {
      branch: { runner: 'codex', model: 'openai/gpt-5', effort: 'low' },
      user: { runner: 'opencode', model: 'provider/default', effort: 'medium' },
    },
    catalog,
  )
  assert.equal(selection.runner.effective, 'codex')
  assert.equal(selection.model.effective, 'openai/gpt-5')
  assert.equal(selection.effort.effective, 'low')
  assert.equal(profile.harness, 'claude-code')
})

test('PC-04 uses canonical runner/model/effort helpers for snap and ignored states', () => {
  const snapped = resolveEffectiveRun(
    profile,
    { nextRun: { runner: 'claude-code', model: 'openai/gpt-5', effort: 'ultracode' } },
    catalog,
  )
  assert.equal(snapped.model.effective, 'anthropic/claude-opus-4-1')
  assert.equal(snapped.model.fidelity, 'snapped')
  assert.equal(snapped.effort.effective, 'ultracode')
  const ignored = resolveEffectiveRun(
    profile,
    { nextRun: { runner: 'amp', model: 'anthropic/claude-sonnet-4-5', effort: 'high' } },
    { ...catalog, supportedRunners: ['amp'] },
  )
  assert.equal(ignored.model.fidelity, 'ignored')
  assert.equal(ignored.effort.fidelity, 'ignored')
})

test('PC-05 blocks provider errors and records accepted warning codes', async () => {
  const receipts = new MemoryReceiptStore()
  const admission = new RunAdmissionController({
    provider: deterministicProvider,
    runtime: {
      async confirmCapabilities() {},
      async admit(input) {
        return receipt(input)
      },
    },
    receipts,
    now: () => new Date(0).toISOString(),
  })
  const source = documentFor(admissionProfile)
  await assert.rejects(
    admission.prepare({
      identifiers: {
        operationId: 'op-1',
        turnId: 'turn-1',
        branchId: 'branch-1',
        conversationId: 'conv-1',
      },
      source,
      connection: connection(),
    }),
  )
  const prepared = await admission.prepare({
    identifiers: {
      operationId: 'op-2',
      turnId: 'turn-2',
      branchId: 'branch-1',
      conversationId: 'conv-1',
    },
    source,
    connection: connection(),
    acceptedWarningCodes: ['NORMALIZED_MODEL'],
  })
  assert.deepEqual(prepared.preAdmission.validation.acceptedWarningCodes, ['NORMALIZED_MODEL'])
  assert.equal(prepared.preAdmission.validation.normalizedProfileDigest, source.profileDigest)
  assert.equal(receipts.preAdmissions().length, 1)
})

test('PC-06 deterministic CLI Bridge materialization records exact generated paths and snapshot digest', async () => {
  const receipts = new MemoryReceiptStore()
  const admission = new RunAdmissionController({
    provider: deterministicProvider,
    runtime: {
      async confirmCapabilities() {},
      async admit(input) {
        return receipt(input, {
          generatedPaths: [{ path: '.braid/profile.json', mode: 0o600 }],
          runtimeRunId: 'run-local',
          providerSessionId: 'session-local',
        })
      },
    },
    receipts,
    now: () => new Date(0).toISOString(),
  })
  const source = documentFor(admissionProfile)
  const prepared = await admission.prepare({
    identifiers: {
      operationId: 'op-bridge',
      turnId: 'turn-bridge',
      branchId: 'branch-1',
      conversationId: 'conv-1',
    },
    source,
    connection: connection(),
    acceptedWarningCodes: ['NORMALIZED_MODEL'],
  })
  const result = await admission.admit({ prepared, connection: connection() })
  assert.equal(
    result.postMaterialization?.materialization.generatedPaths[0]?.path,
    '.braid/profile.json',
  )
  assert.equal(result.postMaterialization?.effectiveProfileDigest, source.profileDigest)
})

test('PC-07 deterministic Tangle sandbox materialization retains placement and immutable profile digest', async () => {
  const sandboxProvider: ConnectionProviderPort = {
    ...deterministicProvider,
    kind: 'tangle-sandbox',
  }
  const receipts = new MemoryReceiptStore()
  const admission = new RunAdmissionController({
    provider: sandboxProvider,
    runtime: {
      async confirmCapabilities() {},
      async admit(input) {
        return receipt(input, {
          environmentId: 'environment-1',
          placement: { kind: 'sandbox', region: 'local-test' },
        })
      },
    },
    receipts,
    now: () => new Date(0).toISOString(),
  })
  const source = documentFor(admissionProfile)
  const sandbox = createConnectionRecord({
    id: 'sandbox',
    kind: 'tangle-sandbox',
    name: 'Sandbox',
    account: 'team-a',
    now: new Date(0).toISOString(),
  })
  const prepared = await admission.prepare({
    identifiers: {
      operationId: 'op-sandbox',
      turnId: 'turn-sandbox',
      branchId: 'branch-1',
      conversationId: 'conv-1',
    },
    source,
    connection: sandbox,
    acceptedWarningCodes: ['NORMALIZED_MODEL'],
  })
  const result = await admission.admit({ prepared, connection: sandbox })
  assert.equal(result.postMaterialization?.materialization.environmentId, 'environment-1')
  assert.deepEqual(result.postMaterialization?.materialization.placement, {
    kind: 'sandbox',
    region: 'local-test',
  })
  assert.equal(result.postMaterialization?.effectiveProfileDigest, source.profileDigest)
})

test('PC-08 keeps credentials as references and excludes values from exports', async () => {
  const canary = 'w7-secret-canary-not-persisted'
  process.env.W7_CANARY = canary
  const credentials = new EnvironmentCredentialStore()
  const reference: CredentialReference = { kind: 'env', id: 'W7_CANARY' }
  const handle = await credentials.resolve(reference)
  const observed = await handle.use(async (value) => value)
  assert.equal(observed, canary)
  assert.equal(
    JSON.stringify(
      createConnectionRecord({
        id: 'c',
        kind: 'tangle-inference',
        name: 'Tangle',
        credentialRef: reference,
        now: new Date(0).toISOString(),
      }),
    ).includes(canary),
    false,
  )
  assert.equal(exportProfile(profile).json.includes(canary), false)
  delete process.env.W7_CANARY
})

test('PC-09 atomically saves, validates written bytes, rejects concurrent edits, and refuses symlink sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-'))
  try {
    const path = join(directory, 'profile.json')
    await writeFile(path, JSON.stringify({ name: 'before' }))
    const source = await new ProfileSourceRegistry().resolve(path)
    const draft = openProfileEditor(source)
    const changed = editRawProfile(
      draft,
      JSON.stringify({ name: 'after', extensions: { 'x.keep': { value: true } } }, null, 2),
    )
    const saved = await saveProfileAtomically(path, changed)
    assert.equal(saved.profile.name, 'after')
    assert.equal(
      (JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>).name,
      'after',
    )
    const exportedPath = join(directory, 'export.json')
    const exported = await exportProfileAtomically(exportedPath, changed.profile as AgentProfile)
    assert.equal(exported.path, exportedPath)
    assert.equal(JSON.parse(await readFile(exportedPath, 'utf8')).name, 'after')
    await writeFile(path, JSON.stringify({ name: 'outside-edit' }))
    await assert.rejects(saveProfileAtomically(path, changed), /changed since/u)
    const link = join(directory, 'link.json')
    await symlink(path, link)
    await assert.rejects(new ProfileSourceRegistry().resolve(link), /symbolic link/u)
    const outsideDirectory = join(directory, 'outside')
    await mkdir(outsideDirectory)
    await writeFile(join(outsideDirectory, 'nested.json'), JSON.stringify({ name: 'outside' }))
    const linkDirectory = join(directory, 'link-directory')
    await symlink(outsideDirectory, linkDirectory)
    await assert.rejects(
      new ProfileSourceRegistry().resolve(join(linkDirectory, 'nested.json')),
      /symbolic-link directory/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('safe discovery does not scan or activate untrusted workspace references', async () => {
  const registry = new ProfileSourceRegistry()
  const discovered = await discoverProfiles(
    {
      workspaceReferences: ['inline:{"name":"blocked"}'],
      userReferences: ['inline:{"name":"user"}'],
    },
    registry,
  )
  assert.deepEqual(
    discovered.map((entry) => entry.document?.profile.name),
    ['user'],
  )
})

test('PC-10 binds workspace trust to identity and configuration digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-trust-'))
  try {
    const config = join(directory, '.braid-config.json')
    await writeFile(config, '{"profile":"profile.json"}')
    const identity = { root: directory, repositoryIdentity: 'repo-1' }
    const preview = await inspectWorkspaceTrust(identity, [
      { path: config, capabilities: ['project-config', 'profile-source'] },
    ])
    const store = new WorkspaceTrustStore()
    assert.throws(() => store.requireTrusted(preview), /not trusted/u)
    store.approve(preview, new Date(0).toISOString())
    store.requireTrusted(preview)
    await writeFile(config, '{"profile":"changed.json"}')
    const changed = await inspectWorkspaceTrust(identity, [
      { path: config, capabilities: ['project-config', 'profile-source'] },
    ])
    assert.throws(() => store.requireTrusted(changed), /not trusted/u)
    store.approve(changed, new Date(0).toISOString())
    store.requireTrusted(changed)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('PC-11 maps provider health and capabilities without creating a resource', async () => {
  const responses: ConnectionHttpResponse[] = [
    { status: 401, payload: { message: 'no' } },
    { status: 429, payload: { message: 'slow' } },
    {
      status: 200,
      payload: {
        environment: capabilities().environment,
        runners: catalog.supportedRunners,
        models: catalog.modelIds,
        modelReasoning: catalog.modelReasoning,
      },
    },
  ]
  const transport: ConnectionHttpTransport = {
    async request() {
      return responses.shift() ?? { status: 200, payload: {} }
    },
  }
  const provider = createCliBridgeProvider(transport)
  const record = connection()
  assert.equal((await provider.health(record)).status, 'unauthorized')
  assert.equal((await provider.health(record)).status, 'rate-limited')
  const reported = await provider.capabilities(record)
  assert.deepEqual(reported.supportedRunners, catalog.supportedRunners)
  assert.equal(createTangleInferenceProvider(transport).kind, 'tangle-inference')
  assert.equal(createTangleSandboxProvider(transport).kind, 'tangle-sandbox')
})

test('PC-12 removal blocks active control and does not destroy historical state', async () => {
  const registry = new ConnectionRegistry()
  const controller = new ConnectionController({
    registry,
    providers: [deterministicProvider],
    now: () => new Date(0).toISOString(),
  })
  await controller.setup({
    id: 'bridge-local',
    kind: 'cli-bridge',
    name: 'Local bridge',
    endpoint: 'http://127.0.0.1:7331',
    now: new Date(0).toISOString(),
  })
  const lease = registry.runLeases().claim('bridge-local', 'run-1')
  await assert.rejects(
    controller.remove('bridge-local', {
      activeRuns: [],
      detachedRuns: [],
      environments: ['env-1'],
      credentialReferences: [],
    }),
    /active or detached/u,
  )
  lease.release()
  await controller.remove('bridge-local', {
    activeRuns: [],
    detachedRuns: [],
    environments: ['env-1'],
    credentialReferences: [],
  })
  assert.equal(registry.get('bridge-local'), undefined)
  await controller.setup({
    id: 'env-credential',
    kind: 'cli-bridge',
    name: 'Environment credential',
    endpoint: 'http://127.0.0.1:7331',
    credentialRef: { kind: 'env', id: 'W7_CANARY' },
    now: new Date(0).toISOString(),
  })
  const environmentController = new ConnectionController({
    registry,
    providers: [deterministicProvider],
    credentials: new EnvironmentCredentialStore(),
    now: () => new Date(0).toISOString(),
  })
  await environmentController.remove('env-credential', {
    activeRuns: [],
    detachedRuns: [],
    environments: [],
    credentialReferences: [],
  })
})

test('PR-01 and PR-02 deterministic first-run flow keeps local and cloud placement distinct', () => {
  const source = { reference: 'inline:{}', source: 'inline' as const, document: documentFor() }
  const connections = [
    connection(),
    createConnectionRecord({
      id: 'sandbox',
      kind: 'tangle-sandbox',
      name: 'Cloud sandbox',
      account: 'team-a',
      now: new Date(0).toISOString(),
    }),
  ]
  const firstRun = new FirstRunController()
  firstRun.start({ profiles: [source], connections })
  firstRun.selectProfile(source.reference)
  firstRun.selectConnection('sandbox')
  const confirmation = firstRun.confirm(catalog)
  assert.equal(confirmation.connection.kind, 'tangle-sandbox')
  assert.equal(confirmation.profileDigest, source.document.profileDigest)
  firstRun.accept()
})

test('PR-03 changing runner creates a new effective snapshot without mutating the source profile', () => {
  const first = resolveEffectiveRun(
    profile,
    { nextRun: { runner: 'claude-code', model: 'anthropic/claude-sonnet-4-5' } },
    catalog,
  )
  const second = resolveEffectiveRun(
    profile,
    { nextRun: { runner: 'codex', model: 'openai/gpt-5' } },
    catalog,
  )
  assert.equal(first.profile.harness, 'claude-code')
  assert.equal(second.profile.harness, 'codex')
  assert.equal(profile.harness, 'claude-code')
  assert.notDeepEqual(first.profile, second.profile)
})

const liveEndpoint = process.env.BRAID_LIVE_CLI_BRIDGE_ENDPOINT
const liveBearer = process.env.BRAID_LIVE_CLI_BRIDGE_BEARER

test('protected live CLI Bridge health and capability checks use explicit credentials', {
  skip:
    liveEndpoint === undefined ||
    liveEndpoint.length === 0 ||
    liveBearer === undefined ||
    liveBearer.length === 0
      ? 'BRAID_LIVE_CLI_BRIDGE_ENDPOINT and BRAID_LIVE_CLI_BRIDGE_BEARER are absent'
      : false,
}, async () => {
  const transport = new FetchConnectionHttpTransport({
    credentials: new EnvironmentCredentialStore(),
  })
  if (typeof liveEndpoint !== 'string' || liveEndpoint.length === 0) {
    throw new Error('live endpoint was not narrowed after the protected skip')
  }
  const live = createConnectionRecord({
    id: 'live-cli-bridge',
    kind: 'cli-bridge',
    name: 'Protected live CLI Bridge',
    endpoint: liveEndpoint,
    credentialRef: { kind: 'env', id: 'BRAID_LIVE_CLI_BRIDGE_BEARER' },
    now: new Date().toISOString(),
  })
  const provider = createCliBridgeProvider(transport)
  assert.equal((await provider.health(live)).status, 'healthy')
  const reported = await provider.capabilities(live)
  assert.ok(reported.digest?.startsWith('sha256:'))
})
