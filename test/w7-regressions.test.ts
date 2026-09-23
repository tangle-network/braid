import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  type AgentEnvironmentCapabilities,
  type AgentProfile,
  canonicalAgentProfileDigest,
  defineAgentProfile,
} from '@tangle-network/agent-interface'
import { createBraidApplication } from '../src/app/composition.js'
import {
  ConnectionSetupCancelledError,
  ConnectionSetupTimeoutError,
} from '../src/connection/setup-deadline.js'
import { freezeCapabilitySnapshot } from '../src/controllers/admission-contracts.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import {
  AdmissionRecoveryError,
  AdmissionBindingError,
  type ConnectionCapabilitySnapshot,
  ConnectionController,
  type ConnectionHealth,
  ConnectionPersistenceConflictError,
  type ConnectionProviderPort,
  ConnectionRegistry,
  closeWorkspaceRoot,
  createCliBridgeProvider,
  createConnectionRecord,
  discoverProfiles,
  EnvironmentCredentialStore,
  editStructuredProfile,
  FetchConnectionHttpTransport,
  FirstRunController,
  freezeProfileViewModel,
  HttpConnectionProvider,
  immutableProfileValue,
  inspectWorkspaceTrust,
  isVerifiedWorkspaceTrust,
  JsonAdmissionLedger,
  JsonConnectionRecordPersistence,
  JsonReceiptStore,
  LoadedProfileSourceAdapter,
  LocalProfileSourceAdapter,
  MemoryAdmissionLedger,
  MemoryReceiptStore,
  materializationReceiptDigest,
  openProfileEditor,
  openWorkspaceRoot,
  profileSchemaIdentity,
  type PostMaterializationReceipt,
  type PreAdmissionReceipt,
  ProfileSourceRegistry,
  type ProviderMaterializationReceipt,
  ProviderRequestAbortedError,
  parseCredentialReference,
  profileDocumentFromJson,
  RunAdmissionController,
  type RunAdmissionPort,
  readWorkspaceFile,
  redactProviderValue,
  saveProfileAtomically,
  structuredProfilePage,
  validateCanonicalProfile,
  validateConnectionRecord,
  validateMaterializationReceipt,
  validateProviderOptions,
  type WorkspaceInspectionFile,
  WorkspaceNotTrustedError,
  WorkspaceTrustStore,
  verifyWorkspaceTrust,
  withCapabilityDigest,
} from '../src/index.js'
import { FileLockTimeoutError, fileLockPath, withFileLock } from '../src/persistence/file-lock.js'
import { readFileIdentity } from '../src/profile/profile-files.js'

const now = '2026-08-01T00:00:00.000Z'

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

function capabilities(retrievedAt = now): ConnectionCapabilitySnapshot {
  return {
    environment,
    supportedRunners: ['claude-code'],
    modelIds: ['anthropic/claude-sonnet-4-5'],
    modelReasoning: {},
    retrievedAt,
    source: 'w7-regression',
  }
}

function connection() {
  return createConnectionRecord({
    id: 'bridge',
    kind: 'cli-bridge',
    name: 'bridge',
    endpoint: 'http://127.0.0.1:7331',
    now,
  })
}

function source(profile: Readonly<AgentProfile>, writable = true) {
  return profileDocumentFromJson(JSON.stringify(profile), {
    kind: 'local-file',
    value: '/tmp/profile.json',
    label: 'profile.json',
    writable,
  })
}

function receipt(input: {
  readonly requestDigest: string
  readonly effectiveProfileDigest: string
  readonly capabilityDigest: string
}): ProviderMaterializationReceipt {
  const body = {
    requestDigest: input.requestDigest,
    effectiveProfileDigest: input.effectiveProfileDigest,
    capabilityDigest: input.capabilityDigest,
    generatedPaths: [],
    unsupportedDimensions: [],
    normalizedValues: {},
  } as const
  return { materializationDigest: materializationReceiptDigest(body), ...body }
}

function providerWith(
  capabilitiesValue: ConnectionCapabilitySnapshot | (() => ConnectionCapabilitySnapshot),
): ConnectionProviderPort {
  return {
    kind: 'cli-bridge',
    async health(): Promise<ConnectionHealth> {
      return { status: 'healthy', checkedAt: now }
    },
    async capabilities(): Promise<ConnectionCapabilitySnapshot> {
      return typeof capabilitiesValue === 'function' ? capabilitiesValue() : capabilitiesValue
    },
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  for (;;) {
    const states = await Promise.all(
      paths.map((path) =>
        access(path).then(
          () => true,
          () => false,
        ),
      ),
    )
    if (states.every(Boolean)) return
    await wait(5)
  }
}

function runSaveWorker(
  target: string,
  name: string,
  ready: string,
  start: string,
  result: string,
): Promise<void> {
  const script = `
    import { access, writeFile } from 'node:fs/promises'
    import {
      editStructuredProfile,
      openProfileEditor,
      profileDocumentFromJson,
      readFileIdentity,
      saveProfileAtomically,
    } from './.test-dist/src/index.js'
    const [target, name, ready, start, result] = process.argv.slice(1)
    const read = await readFileIdentity(target)
    if (read === undefined) throw new Error('worker target is missing')
    const document = profileDocumentFromJson(new TextDecoder().decode(read.bytes), {
      kind: 'local-file', value: target, label: 'worker profile', writable: true,
    })
    const draft = editStructuredProfile(openProfileEditor(document, { baselineIdentity: read.identity }), '/name', name)
    await writeFile(ready, '')
    while (true) { try { await access(start); break } catch { await new Promise((resolve) => setTimeout(resolve, 2)) } }
    try { await saveProfileAtomically(target, draft); await writeFile(result, 'success') }
    catch (error) { await writeFile(result, error instanceof Error ? error.name : 'failure') }
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, target, name, ready, start, result],
      {
        cwd: process.cwd(),
        stdio: 'ignore',
      },
    )
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)),
    )
  })
}

function runLedgerWorker(
  target: string,
  operationId: string,
  ready: string,
  start: string,
  result: string,
): Promise<void> {
  const script = `
    import { access, writeFile } from 'node:fs/promises'
    import { JsonAdmissionLedger } from './.test-dist/src/index.js'
    const [target, operationId, ready, start, result] = process.argv.slice(1)
    const ledger = new JsonAdmissionLedger(target)
    await writeFile(ready, '')
    while (true) { try { await access(start); break } catch { await new Promise((resolve) => setTimeout(resolve, 2)) } }
    try {
      const winner = await ledger.reserve({
        operationId,
        operationDigest: 'sha256:' + (operationId === 'one' ? '1' : '2').repeat(64),
        state: 'in-flight',
        startedAt: '2026-08-01T00:00:00.000Z',
      })
      await writeFile(result, winner === undefined ? 'new' : winner.operationId)
    } catch (error) { await writeFile(result, error instanceof Error ? error.name : 'failure') }
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, target, operationId, ready, start, result],
      { cwd: process.cwd(), stdio: 'ignore' },
    )
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`ledger worker exited ${code}`)),
    )
  })
}

test('admission rejects a save-blocked full document before provider or runtime work', async () => {
  const profile = defineAgentProfile({ name: 'unknown-field' })
  const blocked = profileDocumentFromJson(
    JSON.stringify({ ...profile, futureCanonicalField: true }),
    { kind: 'local-file', value: '/tmp/profile.json', label: 'profile', writable: true },
  )
  assert.equal(blocked.saveBlock, 'unrecognized-fields')
  let capabilityCalls = 0
  let runtimeCalls = 0
  const provider = providerWith({ ...capabilities(), source: 'unknown-field-test' })
  const countingProvider: ConnectionProviderPort = {
    ...provider,
    async capabilities(connection, options) {
      capabilityCalls += 1
      return provider.capabilities(connection, options)
    },
  }
  const admission = new RunAdmissionController({
    provider: countingProvider,
    runtime: {
      async confirmCapabilities() {},
      async admit(input) {
        runtimeCalls += 1
        return receipt(input)
      },
    },
    receipts: new MemoryReceiptStore(),
    now: () => now,
  })
  await assert.rejects(
    admission.prepare({
      identifiers: {
        operationId: 'unknown',
        turnId: 'turn',
        branchId: 'branch',
        conversationId: 'conversation',
      },
      source: blocked,
      connection: connection(),
    }),
    /save-blocked|cannot be safely saved|unrecognized-fields/u,
  )
  assert.equal(capabilityCalls, 0)
  assert.equal(runtimeCalls, 0)
})

test('workspace admission ignores stale or incomplete caller previews and binds resource writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-authority-'))
  try {
    const config = join(directory, '.braid-config.json')
    await writeFile(config, '{"profile":"profile.json"}')
    const identity = { root: directory, repositoryIdentity: 'w7-authority' }
    const files: readonly WorkspaceInspectionFile[] = [
      { path: config, capabilities: ['project-config', 'resource-write'] },
    ]
    const stale = await inspectWorkspaceTrust(identity, files)
    const trust = new WorkspaceTrustStore()
    trust.approve(stale, now)
    await writeFile(config, '{"profile":"changed.json"}')
    const profile = defineAgentProfile({ name: 'workspace-bound' })
    const admission = new RunAdmissionController({
      provider: providerWith({ ...capabilities(), source: 'workspace-test' }),
      runtime: {
        async confirmCapabilities() {},
        async admit(input) {
          return receipt(input)
        },
      },
      receipts: new MemoryReceiptStore(),
      workspaceTrust: trust,
      now: () => now,
    })
    const authority = { identity, files }
    await assert.rejects(
      admission.prepare({
        identifiers: {
          operationId: 'stale',
          turnId: 'turn',
          branchId: 'branch',
          conversationId: 'conversation',
        },
        source: source(profile),
        connection: connection(),
        workspace: { authority, trustPreview: stale, request: { profile: 'profile.json' } },
      }),
      WorkspaceNotTrustedError,
    )

    await writeFile(config, '{"profile":"profile.json"}')
    await trust.approveAuthoritative(identity, files, now)
    const incomplete = await inspectWorkspaceTrust(identity, [])
    const prepared = await admission.prepare({
      identifiers: {
        operationId: 'fresh',
        turnId: 'turn',
        branchId: 'branch',
        conversationId: 'conversation',
      },
      source: source(profile),
      connection: connection(),
      workspace: { authority, trustPreview: incomplete, request: { profile: 'profile.json' } },
    })
    assert.deepEqual(prepared.preAdmission.workspace.trust?.capabilities, [
      'project-config',
      'resource-write',
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('resource destinations cannot be admitted without resource-write approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-resource-'))
  try {
    const config = join(directory, '.braid-config.json')
    await writeFile(config, '{}')
    const identity = { root: directory }
    const files: readonly WorkspaceInspectionFile[] = [
      { path: config, capabilities: ['project-config'] },
    ]
    const trust = new WorkspaceTrustStore()
    await trust.approveAuthoritative(identity, files, now)
    const profile = defineAgentProfile({
      name: 'resource-writer',
      resources: {
        files: [
          {
            path: 'generated.txt',
            resource: { kind: 'inline', name: 'generated', content: 'data' },
            executable: false,
          },
        ],
      },
    })
    const admission = new RunAdmissionController({
      provider: providerWith({ ...capabilities(), source: 'resource-test' }),
      runtime: {
        async confirmCapabilities() {},
        async admit(input) {
          return receipt(input)
        },
      },
      receipts: new MemoryReceiptStore(),
      workspaceTrust: trust,
      now: () => now,
    })
    await assert.rejects(
      admission.prepare({
        identifiers: {
          operationId: 'resource-blocked',
          turnId: 'turn',
          branchId: 'branch',
          conversationId: 'conversation',
        },
        source: source(profile),
        connection: connection(),
        workspace: { authority: { identity, files }, request: {} },
      }),
      /resource-write|not trusted/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('ordinary inline profile names do not require the namedProfiles capability', async () => {
  const noCatalog = {
    ...capabilities(),
    environment: { ...environment, profile: { ...environment.profile, namedProfiles: false } },
  }
  const admission = new RunAdmissionController({
    provider: providerWith(noCatalog),
    runtime: {
      async confirmCapabilities() {},
      async admit(input) {
        return receipt(input)
      },
    },
    receipts: new MemoryReceiptStore(),
    now: () => now,
  })
  await assert.doesNotReject(
    admission.prepare({
      identifiers: {
        operationId: 'inline-name',
        turnId: 'turn',
        branchId: 'branch',
        conversationId: 'conversation',
      },
      source: source(defineAgentProfile({ name: 'ordinary name' })),
      connection: connection(),
    }),
  )
  const providerCatalogProfile = profileDocumentFromJson(JSON.stringify({ name: 'catalog name' }), {
    kind: 'provider-catalog',
    value: 'provider://catalog/name',
    label: 'catalog name',
    writable: true,
  })
  await assert.rejects(
    admission.prepare({
      identifiers: {
        operationId: 'catalog-name',
        turnId: 'turn',
        branchId: 'branch',
        conversationId: 'conversation',
      },
      source: providerCatalogProfile,
      connection: connection(),
    }),
    /namedProfiles|name/u,
  )
})

test('configured project profiles require exact profile-source workspace approval', async () => {
  const configured = profileDocumentFromJson('{"name":"project profile"}', {
    kind: 'configured',
    value: 'configured:project-profile',
    label: 'project profile',
    writable: true,
  })
  const admission = new RunAdmissionController({
    provider: providerWith({ ...capabilities(), source: 'configured-trust' }),
    runtime: {
      async confirmCapabilities() {},
      async admit(input) {
        return receipt(input)
      },
    },
    receipts: new MemoryReceiptStore(),
    now: () => now,
  })
  await assert.rejects(
    admission.prepare({
      identifiers: {
        operationId: 'configured-trust',
        turnId: 'turn',
        branchId: 'branch',
        conversationId: 'conversation',
      },
      source: configured,
      connection: connection(),
    }),
    WorkspaceNotTrustedError,
  )
})

test('workspace admission binds the caller identity to the inspected authority', async () => {
  const first = await mkdtemp(join(tmpdir(), 'braid-w7-workspace-first-'))
  const second = await mkdtemp(join(tmpdir(), 'braid-w7-workspace-second-'))
  try {
    const config = join(first, 'config.json')
    await writeFile(config, '{}')
    const identity = { root: first }
    const files: readonly WorkspaceInspectionFile[] = [
      { path: config, capabilities: ['project-config'] },
    ]
    const trust = new WorkspaceTrustStore()
    await trust.approveAuthoritative(identity, files, now)
    const admission = new RunAdmissionController({
      provider: providerWith({ ...capabilities(), source: 'workspace-binding' }),
      runtime: {
        async confirmCapabilities() {},
        async admit(input) {
          return receipt(input)
        },
      },
      receipts: new MemoryReceiptStore(),
      workspaceTrust: trust,
      now: () => now,
    })
    await assert.rejects(
      admission.prepare({
        identifiers: {
          operationId: 'workspace-binding',
          turnId: 'turn',
          branchId: 'branch',
          conversationId: 'conversation',
        },
        source: source(defineAgentProfile({ name: 'workspace-bound' })),
        connection: connection(),
        workspace: {
          identity: second,
          authority: { identity, files },
          request: {},
        },
      }),
      AdmissionBindingError,
    )
  } finally {
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('profile discovery ignores forged workspace trust objects', async () => {
  const forged = {
    record: { capabilities: ['profile-source'] },
    preview: {},
  } as never
  assert.deepEqual(
    await discoverProfiles(
      {
        workspaceTrust: forged,
        workspaceReferences: ['inline:{"name":"forged"}'],
      },
      new ProfileSourceRegistry(),
    ),
    [],
  )
})

test('workspace trust brands cannot be copied from an approved value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-w7-trust-brand-'))
  try {
    const preview = await inspectWorkspaceTrust({ root }, [])
    const store = new WorkspaceTrustStore()
    store.approve(preview, now)
    const verified = verifyWorkspaceTrust(store, preview)
    assert.ok(verified)
    const brand = Object.getOwnPropertySymbols(verified)[0]
    assert.ok(brand)
    const forged = Object.freeze({
      [brand]: true,
      record: { capabilities: ['profile-source'] },
      preview: {},
    })
    assert.equal(isVerifiedWorkspaceTrust(forged), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('descriptor-bound workspace inspection rejects parent and final replacement races', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-workspace-race-'))
  const outside = await mkdtemp(join(tmpdir(), 'braid-w7-outside-'))
  try {
    const safe = join(directory, 'safe')
    const safeReal = join(directory, 'safe-real')
    const outsideConfig = join(outside, 'config.json')
    await mkdir(safe)
    await writeFile(join(safe, 'config.json'), 'safe')
    await writeFile(outsideConfig, 'outside')
    const identity = { root: directory }
    const parentFile = join(safe, 'config.json')
    let stop = false
    const parentAttacker = (async () => {
      while (!stop) {
        try {
          await rename(safe, safeReal)
          await symlink(outside, safe)
          await rm(safe)
          await rename(safeReal, safe)
        } catch {
          await rm(safe, { recursive: true, force: true }).catch(() => undefined)
          await rename(safeReal, safe).catch(() => undefined)
        }
      }
    })()
    const outsideDigest = (await readFileIdentity(outsideConfig))?.identity.digest
    let escaped = false
    for (let index = 0; index < 600; index += 1) {
      try {
        const preview = await inspectWorkspaceTrust(identity, [
          { path: parentFile, capabilities: ['project-config'] },
        ])
        escaped ||= preview.entries.some((entry) => entry.digest === outsideDigest)
      } catch (error) {
        assert.ok(error instanceof Error)
      }
    }
    stop = true
    await parentAttacker
    assert.equal(escaped, false)

    const final = join(directory, 'final.json')
    await writeFile(final, 'safe-final')
    stop = false
    const finalAttacker = (async () => {
      while (!stop) {
        try {
          await rename(final, `${final}.real`)
          await symlink(outsideConfig, final)
          await rm(final)
          await rename(`${final}.real`, final)
        } catch {
          await rm(final, { force: true }).catch(() => undefined)
          await rename(`${final}.real`, final).catch(() => undefined)
        }
      }
    })()
    let finalEscaped = false
    for (let index = 0; index < 300; index += 1) {
      try {
        const preview = await inspectWorkspaceTrust(identity, [
          { path: final, capabilities: ['project-config'] },
        ])
        finalEscaped ||= preview.entries.some((entry) => entry.digest === outsideDigest)
      } catch {
        // A replacement is expected to fail closed.
      }
    }
    stop = true
    await finalAttacker
    assert.equal(finalEscaped, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('workspace root descriptors reject a directory replacement race', async () => {
  const base = await mkdtemp(join(tmpdir(), 'braid-w7-root-race-'))
  const root = join(base, 'root')
  const moved = join(base, 'moved')
  const outside = join(base, 'outside')
  try {
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(root, 'config.json'), 'safe')
    await writeFile(join(outside, 'config.json'), 'outside')
    const outsideDigest = `sha256:${createHash('sha256').update('outside').digest('hex')}`
    let stop = false
    let escaped = false
    const stableRoot = await openWorkspaceRoot(root)
    const attacker = (async () => {
      while (!stop) {
        try {
          await rename(root, moved)
          await rename(outside, root)
          await rename(root, outside)
          await rename(moved, root)
        } catch {
          await rename(moved, root).catch(() => undefined)
          await rename(outside, root).catch(() => undefined)
        }
      }
    })()
    try {
      for (let index = 0; index < 4_000 && !escaped; index += 1) {
        try {
          const read = await readWorkspaceFile(stableRoot, join(root, 'config.json'), 128)
          escaped = read.digest === outsideDigest
        } catch {
          // A replacement is expected to fail closed.
        }
      }
    } finally {
      stop = true
      await attacker
      await closeWorkspaceRoot(stableRoot).catch(() => undefined)
    }
    assert.equal(escaped, false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('restarting first-run clears stale profile, connection, and confirmation state', () => {
  const firstRun = new FirstRunController()
  const profile = defineAgentProfile({ name: 'first-run', harness: 'claude-code' })
  const document = profileDocumentFromJson(JSON.stringify(profile), {
    kind: 'inline',
    value: 'inline',
    label: 'inline',
    writable: false,
  })
  const profileEntry = { reference: 'inline:first-run', source: 'inline' as const, document }
  const connection = createConnectionRecord({
    id: 'first-run-connection',
    kind: 'cli-bridge',
    name: 'First-run connection',
    endpoint: 'http://127.0.0.1:7331',
    now,
  })
  firstRun.start({ profiles: [profileEntry], connections: [connection] })
  firstRun.selectProfile(profileEntry.reference)
  firstRun.selectConnection(connection.id)
  firstRun.confirm({ supportedRunners: ['claude-code'], modelIds: [], modelReasoning: {} })

  const restarted = firstRun.start({ profiles: [], connections: [] })
  assert.equal(restarted.stage, 'profile')
  assert.equal(Object.hasOwn(restarted, 'selectedProfile'), false)
  assert.equal(Object.hasOwn(restarted, 'selectedConnection'), false)
  assert.equal(Object.hasOwn(restarted, 'confirmation'), false)
})

test('profile drafts cannot be rebound or overwrite a read-only target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-editor-binding-'))
  try {
    const sourcePath = join(directory, 'source.json')
    const otherPath = join(directory, 'other.json')
    const text = '{"name":"before"}'
    await writeFile(sourcePath, text)
    await writeFile(otherPath, text)
    const draft = editStructuredProfile(
      openProfileEditor(
        profileDocumentFromJson(text, {
          kind: 'local-file',
          value: sourcePath,
          label: 'source.json',
          writable: true,
        }),
      ),
      '/name',
      'changed',
    )
    await assert.rejects(saveProfileAtomically(otherPath, draft), /draft belongs to/u)
    assert.equal(await readFile(otherPath, 'utf8'), text)

    const readOnlyDraft = editStructuredProfile(
      openProfileEditor(
        profileDocumentFromJson(text, {
          kind: 'inline',
          value: 'inline',
          label: 'inline',
          writable: false,
        }),
      ),
      '/name',
      'read-only-change',
    )
    await assert.rejects(
      saveProfileAtomically(otherPath, readOnlyDraft, { allowReadOnlySource: true }),
      /only be saved as a new local file/u,
    )
    assert.equal(await readFile(otherPath, 'utf8'), text)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('profile files reject insecure links and retain the source identity for saves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-profile-file-boundaries-'))
  try {
    const profile = defineAgentProfile({ name: 'file-boundary' })
    const insecure = join(directory, 'world-writable.json')
    await writeFile(insecure, JSON.stringify(profile), { mode: 0o600 })
    await chmod(insecure, 0o666)
    await assert.rejects(new LocalProfileSourceAdapter().resolve(insecure), /world-writable/u)

    const linked = join(directory, 'linked.json')
    const hardlink = join(directory, 'hardlink.json')
    await writeFile(linked, JSON.stringify(profile), { mode: 0o600 })
    await link(linked, hardlink)
    await assert.rejects(new LocalProfileSourceAdapter().resolve(linked), /multiply-linked/u)

    const sourcePath = join(directory, 'source.json')
    const sourceText = JSON.stringify(profile)
    await writeFile(sourcePath, sourceText, { mode: 0o600 })
    const unboundDraft = editStructuredProfile(
      openProfileEditor(
        profileDocumentFromJson(sourceText, {
          kind: 'local-file',
          value: sourcePath,
          label: 'source.json',
          writable: true,
        }),
      ),
      '/name',
      'unbound-change',
    )
    await assert.rejects(
      saveProfileAtomically(sourcePath, unboundDraft),
      /source identity was not captured/u,
    )
    const document = await new LocalProfileSourceAdapter().resolve(sourcePath)
    const invalidDraft = { ...openProfileEditor(document), rawJson: 'not json' }
    await assert.rejects(
      saveProfileAtomically(sourcePath, invalidDraft),
      /draft JSON no longer matches/u,
    )
    assert.equal(await readFile(sourcePath, 'utf8'), sourceText)
    const draft = editStructuredProfile(openProfileEditor(document), '/name', 'changed')
    await rename(sourcePath, `${sourcePath}.old`)
    await writeFile(sourcePath, sourceText, { mode: 0o600 })
    await assert.rejects(saveProfileAtomically(sourcePath, draft), /replaced/u)

    const outsideDirectory = join(directory, 'outside')
    const linkDirectory = join(directory, 'link-directory')
    await mkdir(outsideDirectory)
    await symlink(outsideDirectory, linkDirectory)
    const symlinkedTarget = join(linkDirectory, 'target.json')
    await assert.rejects(
      withFileLock(symlinkedTarget, async () => undefined),
      /symbolic-link lock directory/u,
    )
    assert.equal(
      await access(join(outsideDirectory, '.target.json.braid.lock')).then(
        () => true,
        () => false,
      ),
      false,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('fresh processes serialize profile compare-and-rename to one winner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-profile-race-'))
  try {
    const target = join(directory, 'profile.json')
    const base = defineAgentProfile({ name: 'baseline' })
    await writeFile(target, `${JSON.stringify(base)}\n`, { mode: 0o600 })
    const workers = Array.from({ length: 200 }, (_, index) => {
      const ready = join(directory, `ready-${index}`)
      const result = join(directory, `result-${index}`)
      return {
        ready,
        result,
        promise: runSaveWorker(target, `winner-${index}`, ready, join(directory, 'start'), result),
      }
    })
    await waitForFiles(workers.map((worker) => worker.ready))
    await writeFile(join(directory, 'start'), '')
    await Promise.all(workers.map((worker) => worker.promise))
    const outcomes = await Promise.all(workers.map((worker) => readFile(worker.result, 'utf8')))
    assert.equal(outcomes.filter((outcome) => outcome === 'success').length, 1)
    assert.equal(outcomes.filter((outcome) => outcome !== 'success').length, workers.length - 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('profile locks recover after a crash and never steal a live lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-lock-'))
  try {
    const target = join(directory, 'profile.json')
    const lock = fileLockPath(target)
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, acquiredAt: 0, nonce: 'crashed' }))
    await withFileLock(
      target,
      async () => {
        assert.equal(
          await readFile(lock, 'utf8').then(
            () => true,
            () => false,
          ),
          true,
        )
      },
      { timeoutMs: 1_000, staleAfterMs: 1 },
    )
    assert.equal(
      await readFile(lock, 'utf8').then(
        () => true,
        () => false,
      ),
      true,
    )

    const hardlinkResource = join(directory, 'hardlink-resource')
    const hardlinkTarget = join(directory, 'hardlink-target')
    await writeFile(hardlinkTarget, '')
    await link(hardlinkTarget, fileLockPath(hardlinkResource))
    await assert.rejects(
      withFileLock(hardlinkResource, async () => undefined),
      /multiply-linked/u,
    )

    let release!: () => void
    const held = withFileLock(
      target,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      { timeoutMs: 1_000, staleAfterMs: 1 },
    )
    await waitForFiles([lock])
    await assert.rejects(
      withFileLock(target, async () => undefined, { timeoutMs: 25, staleAfterMs: 1 }),
      FileLockTimeoutError,
    )
    release()
    await held

    const ready = join(directory, 'crash-ready')
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { writeFile } from 'node:fs/promises'
          import { withFileLock } from './.test-dist/src/index.js'
          const [target, ready] = process.argv.slice(1)
          await withFileLock(target, async () => {
            await writeFile(ready, 'ready')
            await new Promise(() => undefined)
          })
        `,
        target,
        ready,
      ],
      { cwd: process.cwd(), stdio: 'ignore' },
    )
    await waitForFiles([ready])
    holder.kill('SIGKILL')
    await new Promise<void>((resolve) => holder.once('exit', () => resolve()))
    await withFileLock(target, async () => undefined, { timeoutMs: 1_000, staleAfterMs: 1 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('independent admission writers retain both ledger operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-ledger-processes-'))
  try {
    const path = join(directory, 'ledger.json')
    const start = join(directory, 'start')
    const workers = ['one', 'two'].map((operationId) => {
      const ready = join(directory, `${operationId}-ready`)
      const result = join(directory, `${operationId}-result`)
      return {
        operationId,
        result,
        promise: runLedgerWorker(path, operationId, ready, start, result),
        ready,
      }
    })
    await waitForFiles(workers.map((worker) => worker.ready))
    await writeFile(start, '')
    await Promise.all(workers.map((worker) => worker.promise))
    assert.deepEqual(await Promise.all(workers.map((worker) => readFile(worker.result, 'utf8'))), [
      'new',
      'new',
    ])
    const ledger = new JsonAdmissionLedger(path)
    assert.equal((await ledger.read('one'))?.state, 'in-flight')
    assert.equal((await ledger.read('two'))?.state, 'in-flight')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('independent connection persistence writers reject stale snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-connection-processes-'))
  try {
    const path = join(directory, 'connections.json')
    const one = createConnectionRecord({
      id: 'one',
      kind: 'cli-bridge',
      name: 'one',
      endpoint: 'http://127.0.0.1:7331',
      now,
    })
    const two = createConnectionRecord({
      id: 'two',
      kind: 'cli-bridge',
      name: 'two',
      endpoint: 'http://127.0.0.1:7331',
      now,
    })
    const first = new JsonConnectionRecordPersistence(path)
    const second = new JsonConnectionRecordPersistence(path)
    await Promise.all([first.load(), second.load()])
    await first.save([one])
    await assert.rejects(second.save([two]), ConnectionPersistenceConflictError)
    assert.deepEqual(
      JSON.parse(await readFile(path, 'utf8')).map((entry: { id: string }) => entry.id),
      ['one'],
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('admission ledger rejects forged digests, invalid times, and mixed outcomes', async () => {
  const ledger = new MemoryAdmissionLedger()
  await assert.rejects(
    ledger.write({
      operationId: 'forged-ledger',
      operationDigest: 'not-a-digest',
      state: 'materialized',
      startedAt: 'not-a-time',
      receiptDigest: 'not-a-digest',
    } as never),
    /sha256|ISO/u,
  )
  await assert.rejects(
    ledger.write({
      operationId: 'mixed-ledger',
      operationDigest: `sha256:${'1'.repeat(64)}`,
      state: 'materialized',
      startedAt: now,
      completedAt: now,
      receiptDigest: `sha256:${'2'.repeat(64)}`,
      failure: 'must not coexist',
    } as never),
    /failure/u,
  )
})

test('materialization receipts require complete bindings and preserve conflicts across restarts', async () => {
  const binding = {
    requestDigest: `sha256:${'1'.repeat(64)}`,
    effectiveProfileDigest: `sha256:${'2'.repeat(64)}`,
    capabilityDigest: `sha256:${'3'.repeat(64)}`,
    expectedUnsupportedDimensions: [],
  }
  const complete = receipt({
    requestDigest: binding.requestDigest,
    effectiveProfileDigest: binding.effectiveProfileDigest,
    capabilityDigest: binding.capabilityDigest,
  })
  const controlPathBody = {
    requestDigest: binding.requestDigest,
    effectiveProfileDigest: binding.effectiveProfileDigest,
    capabilityDigest: binding.capabilityDigest,
    generatedPaths: [{ path: 'safe [31m' }],
    unsupportedDimensions: [],
    normalizedValues: {},
  } as const
  assert.throws(
    () =>
      validateMaterializationReceipt(
        {
          ...controlPathBody,
          generatedPaths: [{ path: 'safe\u001b[31m' }],
          materializationDigest: materializationReceiptDigest(controlPathBody),
        },
        binding,
      ),
    /control/u,
  )
  assert.throws(
    () =>
      validateMaterializationReceipt(
        { ...complete, requestDigest: undefined } as unknown as ProviderMaterializationReceipt,
        binding,
      ),
    /requestDigest/u,
  )
  assert.throws(
    () =>
      validateMaterializationReceipt(
        { ...complete, capabilityDigest: `sha256:${'4'.repeat(64)}` },
        binding,
      ),
    /capability snapshot/u,
  )
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-receipts-'))
  try {
    const path = join(directory, 'receipts.json')
    const receiptProfile = { name: 'receipt' }
    const receiptCapabilities = freezeCapabilitySnapshot({
      environment,
      supportedRunners: [],
      modelIds: [],
      modelReasoning: {},
      retrievedAt: now,
      source: 'test',
    })
    const preCandidate = {
      kind: 'braid.pre-admission' as const,
      schemaVersion: 1 as const,
      receiptDigest: `sha256:${'a'.repeat(64)}`,
      requestedAt: now,
      identifiers: {
        operationId: 'receipt-op',
        turnId: 'turn',
        branchId: 'branch',
        conversationId: 'conversation',
      },
      source: { kind: 'inline' as const, value: 'inline', label: 'inline', writable: true },
      authoredProfile: receiptProfile,
      authoredProfileDigest: canonicalAgentProfileDigest(receiptProfile),
      effectiveProfile: receiptProfile,
      effectiveProfileDigest: canonicalAgentProfileDigest(receiptProfile),
      requested: {},
      selection: {
        runner: { source: 'none' as const, fidelity: 'unset' as const },
        model: { source: 'none' as const, fidelity: 'unset' as const },
        effort: { source: 'none' as const, fidelity: 'unset' as const },
        mode: { source: 'none' as const, fidelity: 'unset' as const },
        profile: receiptProfile,
      },
      connection: { id: 'bridge', kind: 'cli-bridge' as const, name: 'bridge' },
      connectionIdentityDigest: `sha256:${'5'.repeat(64)}`,
      capabilities: {
        environment,
        supportedRunners: [],
        modelIds: [],
        modelReasoning: {},
        retrievedAt: now,
        source: 'test',
        digest: receiptCapabilities.digest,
      },
      schema: profileSchemaIdentity(),
      validation: { issues: [], acceptedWarningCodes: [], normalizedProfileAccepted: false },
      workspace: {},
    } as unknown as PreAdmissionReceipt
    const pre = {
      ...preCandidate,
      receiptDigest: canonicalDigest({
        kind: 'braid.pre-admission',
        schemaVersion: 1,
        requestedAt: preCandidate.requestedAt,
        identifiers: preCandidate.identifiers,
        source: preCandidate.source,
        authoredProfile: preCandidate.authoredProfile,
        authoredProfileDigest: preCandidate.authoredProfileDigest,
        effectiveProfile: preCandidate.effectiveProfile,
        effectiveProfileDigest: preCandidate.effectiveProfileDigest,
        requested: preCandidate.requested,
        connectionIdentityDigest: preCandidate.connectionIdentityDigest,
        connection: preCandidate.connection,
        selection: preCandidate.selection,
        capabilities: preCandidate.capabilities,
        schema: preCandidate.schema,
        workspace: preCandidate.workspace,
        validation: preCandidate.validation,
      }),
    } as PreAdmissionReceipt
    const first = new JsonReceiptStore(path)
    await first.savePreAdmission(pre)
    const tamperedPath = join(directory, 'tampered-receipts.json')
    const tamperedRoot = JSON.parse(await readFile(path, 'utf8')) as {
      pre: Array<Record<string, unknown>>
      post: unknown[]
    }
    const tampered = tamperedRoot.pre[0]
    assert.ok(tampered)
    tampered.effectiveProfile = { name: 'tampered' }
    await writeFile(tamperedPath, JSON.stringify(tamperedRoot))
    await assert.rejects(
      new JsonReceiptStore(tamperedPath).findPostMaterialization('missing'),
      /digest/u,
    )
    await assert.rejects(
      new MemoryReceiptStore().savePreAdmission({
        ...pre,
        receiptDigest: `sha256:${'f'.repeat(64)}`,
      }),
      /digest/u,
    )
    const forgedIdentifiers = { ...pre, identifiers: {} as never }
    await assert.rejects(
      new MemoryReceiptStore().savePreAdmission({
        ...forgedIdentifiers,
        receiptDigest: canonicalDigest({
          kind: 'braid.pre-admission',
          schemaVersion: 1,
          requestedAt: pre.requestedAt,
          identifiers: forgedIdentifiers.identifiers,
          source: pre.source,
          authoredProfile: pre.authoredProfile,
          authoredProfileDigest: pre.authoredProfileDigest,
          effectiveProfile: pre.effectiveProfile,
          effectiveProfileDigest: pre.effectiveProfileDigest,
          requested: pre.requested,
          connectionIdentityDigest: pre.connectionIdentityDigest,
          connection: pre.connection,
          selection: pre.selection,
          capabilities: pre.capabilities,
          schema: pre.schema,
          workspace: pre.workspace,
          validation: pre.validation,
        }),
      }),
      /identifiers/u,
    )
    const restarted = new JsonReceiptStore(path)
    assert.equal(await restarted.findPostMaterialization('missing'), undefined)
    await assert.rejects(
      restarted.savePreAdmission({ ...pre, authoredProfileDigest: binding.requestDigest }),
      /digest/u,
    )
    const postCandidate = {
      kind: 'braid.post-materialization' as const,
      schemaVersion: 1 as const,
      receiptDigest: `sha256:${'b'.repeat(64)}`,
      preAdmissionDigest: pre.receiptDigest,
      admittedAt: now,
      identifiers: pre.identifiers,
      authoredProfileDigest: pre.authoredProfileDigest,
      effectiveProfileDigest: pre.effectiveProfileDigest,
      connection: pre.connection,
      connectionIdentityDigest: pre.connectionIdentityDigest,
      capabilities: pre.capabilities,
      schema: pre.schema,
      requested: pre.requested,
      selection: pre.selection,
      validation: pre.validation,
      materialization: receipt({
        requestDigest: pre.receiptDigest,
        effectiveProfileDigest: pre.effectiveProfileDigest,
        capabilityDigest: pre.capabilities.digest,
      }),
      workspace: pre.workspace,
    } as unknown as PostMaterializationReceipt
    const post = {
      ...postCandidate,
      receiptDigest: canonicalDigest({
        kind: 'braid.post-materialization',
        schemaVersion: 1,
        preAdmissionDigest: postCandidate.preAdmissionDigest,
        admittedAt: postCandidate.admittedAt,
        identifiers: postCandidate.identifiers,
        authoredProfileDigest: postCandidate.authoredProfileDigest,
        effectiveProfileDigest: postCandidate.effectiveProfileDigest,
        connection: postCandidate.connection,
        connectionIdentityDigest: postCandidate.connectionIdentityDigest,
        capabilities: postCandidate.capabilities,
        schema: postCandidate.schema,
        requested: postCandidate.requested,
        selection: postCandidate.selection,
        validation: postCandidate.validation,
        materialization: postCandidate.materialization,
        workspace: postCandidate.workspace,
      }),
    } as PostMaterializationReceipt
    const orphanPath = join(directory, 'orphan-receipts.json')
    await writeFile(orphanPath, JSON.stringify({ pre: [], post: [post] }))
    await assert.rejects(
      new JsonReceiptStore(orphanPath).findPostMaterialization(pre.receiptDigest),
      /without its pre-admission/u,
    )
    await restarted.savePostMaterialization(post)
    assert.equal(
      (await new JsonReceiptStore(path).findPostMaterialization(pre.receiptDigest))?.receiptDigest,
      post.receiptDigest,
    )
    const childResult = join(directory, 'child-result')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { JsonReceiptStore } from './.test-dist/src/index.js'; const store = new JsonReceiptStore(process.argv[1]); const value = await store.findPostMaterialization(process.argv[2]); await (await import('node:fs/promises')).writeFile(process.argv[3], value?.receiptDigest ?? 'missing')`,
          path,
          pre.receiptDigest,
          childResult,
        ],
        { cwd: process.cwd(), stdio: 'ignore' },
      )
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`receipt reader exited ${code}`)),
      )
    })
    assert.equal(await readFile(childResult, 'utf8'), post.receiptDigest)
    const alteredPost = {
      ...post,
      admittedAt: '2026-08-02T00:00:00.000Z',
      receiptDigest: canonicalDigest({
        kind: 'braid.post-materialization',
        schemaVersion: 1,
        preAdmissionDigest: post.preAdmissionDigest,
        admittedAt: '2026-08-02T00:00:00.000Z',
        identifiers: post.identifiers,
        authoredProfileDigest: post.authoredProfileDigest,
        effectiveProfileDigest: post.effectiveProfileDigest,
        connection: post.connection,
        connectionIdentityDigest: post.connectionIdentityDigest,
        capabilities: post.capabilities,
        schema: post.schema,
        requested: post.requested,
        selection: post.selection,
        validation: post.validation,
        materialization: post.materialization,
        workspace: post.workspace,
      }),
    }
    await assert.rejects(
      new JsonReceiptStore(path).savePostMaterialization(alteredPost),
      /different materialization receipt/u,
    )
    const memory = new MemoryReceiptStore()
    await memory.savePreAdmission(pre)
    await memory.savePostMaterialization(post)
    await assert.rejects(
      memory.savePostMaterialization(alteredPost),
      /different materialization receipt/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('dispatch confirms the capability digest captured during preparation', async () => {
  let calls = 0
  let runtimeCalls = 0
  let confirmations = 0
  const provider = providerWith(() => {
    calls += 1
    return capabilities(calls === 1 ? now : '2026-08-02T00:00:00.000Z')
  })
  const admission = new RunAdmissionController({
    provider,
    runtime: {
      async confirmCapabilities() {
        confirmations += 1
      },
      async admit(input) {
        runtimeCalls += 1
        return receipt(input)
      },
    },
    receipts: new MemoryReceiptStore(),
    now: () => now,
  })
  const prepared = await admission.prepare({
    identifiers: {
      operationId: 'capability-change',
      turnId: 'turn',
      branchId: 'branch',
      conversationId: 'conversation',
    },
    source: source(defineAgentProfile({ name: 'capability-bound' })),
    connection: connection(),
  })
  await assert.rejects(admission.admit({ prepared }), /capabilities changed/u)
  assert.equal(runtimeCalls, 0)
  assert.equal(calls, 2)
  assert.equal(confirmations, 0)
})

test('dispatch rejects a forged prepared receipt before reaching the runtime', async () => {
  let dispatchedProfile: AgentProfile | undefined
  const admission = new RunAdmissionController({
    provider: providerWith(capabilities()),
    runtime: {
      async confirmCapabilities() {},
      async admit(input) {
        dispatchedProfile = input.profile
        return receipt(input)
      },
    },
    receipts: new MemoryReceiptStore(),
    now: () => now,
  })
  const sourceDocument = source(defineAgentProfile({ name: 'prepared' }))
  const prepared = await admission.prepare({
    identifiers: {
      operationId: 'forged-prepared',
      turnId: 'turn',
      branchId: 'branch',
      conversationId: 'conversation',
    },
    source: sourceDocument,
    connection: connection(),
  })
  const forged = {
    ...prepared,
    preAdmission: {
      ...prepared.preAdmission,
      effectiveProfile: defineAgentProfile({ name: 'forged' }),
    },
  }
  await assert.rejects(admission.admit({ prepared: forged }), AdmissionBindingError)
  assert.equal(dispatchedProfile, undefined)
})

test('materialization keeps an in-flight ledger entry until its receipt can recover', async () => {
  const baseLedger = new MemoryAdmissionLedger()
  let allowCompletion = false
  let runtimeCalls = 0
  const ledger = {
    read: (operationId: string) => baseLedger.read(operationId),
    reserve: (entry: Parameters<NonNullable<typeof baseLedger.reserve>>[0]) =>
      baseLedger.reserve(entry),
    async write(entry: Parameters<typeof baseLedger.write>[0]) {
      if (entry.state === 'materialized' && !allowCompletion) {
        throw new Error('simulated ledger outage')
      }
      await baseLedger.write(entry)
    },
  }
  const receipts = new MemoryReceiptStore()
  const admission = new RunAdmissionController({
    provider: providerWith({ ...capabilities(), source: 'recovery-test' }),
    runtime: {
      async confirmCapabilities() {},
      async admit(input) {
        runtimeCalls += 1
        return receipt(input)
      },
    },
    receipts,
    ledger,
    now: () => now,
  })
  const prepared = await admission.prepare({
    identifiers: {
      operationId: 'recoverable-materialization',
      turnId: 'turn',
      branchId: 'branch',
      conversationId: 'conversation',
    },
    source: source(defineAgentProfile({ name: 'recoverable' })),
    connection: connection(),
  })
  await assert.rejects(admission.admit({ prepared }), AdmissionRecoveryError)
  assert.equal(runtimeCalls, 1)
  assert.equal((await baseLedger.read('recoverable-materialization'))?.state, 'in-flight')
  assert.notEqual(
    await receipts.findPostMaterialization?.(prepared.preAdmission.receiptDigest),
    undefined,
  )
  allowCompletion = true
  const recovered = await admission.admit({ prepared })
  assert.equal(
    recovered.postMaterialization?.preAdmissionDigest,
    prepared.preAdmission.receiptDigest,
  )
  assert.equal(runtimeCalls, 1)
  assert.equal((await baseLedger.read('recoverable-materialization'))?.state, 'materialized')
})

test('Tangle inference resolves only routerCredential at the adapter boundary', async () => {
  const seen: string[] = []
  const credentials = {
    async store() {
      throw new Error('not used')
    },
    async resolve(reference: { readonly kind: 'os' | 'env' | 'session'; readonly id: string }) {
      return {
        use: async <T>(operation: (value: string) => Promise<T>) =>
          operation(reference.id === 'router' ? 'router-secret' : 'generic-secret'),
      }
    },
    async remove() {},
  }
  const transport = new FetchConnectionHttpTransport({
    credentials,
    fetchImpl: (async (_url, init) => {
      if (init === undefined) throw new Error('request init missing')
      const headers = init.headers as Record<string, string> | undefined
      const authorization = headers === undefined ? undefined : headers.authorization
      seen.push(authorization ?? '')
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  })
  const inference = {
    ...createConnectionRecord({
      id: 'inference',
      kind: 'tangle-inference',
      name: 'inference',
      credentialRef: { kind: 'os', id: 'generic' },
      providerOptions: {
        routerBaseUrl: 'http://127.0.0.1:7331',
        routerCredential: { kind: 'credential-ref', reference: 'os:router' },
      },
      now,
    }),
  }
  const tangleProvider = new HttpConnectionProvider({
    kind: 'tangle-inference',
    transport,
  })
  const health = await tangleProvider.health(inference)
  assert.equal(health.status, 'healthy')
  assert.deepEqual(seen, ['Bearer router-secret'])
  assert.equal(JSON.stringify(health).includes('router-secret'), false)
})

test('OS credentials enforce namespace and validate labels before backend mutation', async () => {
  const writes: string[] = []
  const values = new Map<string, string>()
  const backend = {
    platform: 'linux-secret-service' as const,
    async set(label: string, value: string) {
      writes.push(label)
      values.set(label, value)
    },
    async get(label: string) {
      return values.get(label)
    },
    async delete(label: string) {
      values.delete(label)
    },
  }
  const { OperatingSystemCredentialStore } = await import('../src/connection/credentials.js')
  assert.throws(() => new OperatingSystemCredentialStore(backend, 'other'), /exact.*namespace/u)
  const store = new OperatingSystemCredentialStore(backend)
  await assert.rejects(store.store({ label: 'bad/name', value: 'secret' }), /label/u)
  assert.deepEqual(writes, [])
  const reference = await store.store({ label: 'router', value: 'secret' })
  assert.equal(reference.id, 'braid/router')
  await assert.rejects(store.resolve(parseCredentialReference('os:other/router')), /namespace/u)
  await assert.rejects(store.remove(parseCredentialReference('os:other/router')), /namespace/u)
})

test('connection removal cannot acknowledge away an authoritative run lease', () => {
  const registry = new ConnectionRegistry()
  const record = connection()
  registry.save(record)
  const lease = registry.runLeases().claim(record.id, 'active-run')
  try {
    assert.throws(
      () =>
        registry.remove(record.id, {
          activeRuns: [],
          detachedRuns: [],
          environments: [],
          credentialReferences: [],
        }),
      /active or detached/u,
    )
  } finally {
    lease.release()
  }
  const restored = new ConnectionRegistry()
  restored.save(record)
  assert.throws(
    () =>
      restored.remove(record.id, {
        activeRuns: ['run-from-another-process'],
        detachedRuns: [],
        environments: [],
        credentialReferences: [],
      }),
    /active or detached/u,
  )
})

test('connection identity cannot be rebound while a run lease is held', () => {
  const registry = new ConnectionRegistry()
  const record = connection()
  registry.save(record)
  const changed = createConnectionRecord({
    id: record.id,
    kind: record.kind,
    name: record.name,
    endpoint: 'http://127.0.0.1:7444',
    now,
  })
  const lease = registry.runLeases().claim(record.id, 'bound-run')
  try {
    assert.throws(() => registry.save(changed), /active or detached/u)
    assert.throws(() => registry.restore([changed]), /active or detached/u)
    assert.equal(registry.get(record.id)?.endpoint, record.endpoint)
  } finally {
    lease.release()
  }
  assert.equal(registry.save(changed).endpoint, changed.endpoint)
})

test('connection removal fails closed when credential cleanup is not atomic', async () => {
  const registry = new ConnectionRegistry()
  const record = createConnectionRecord({
    id: 'multi-credential',
    kind: 'tangle-sandbox',
    name: 'multi credential',
    credentialRef: { kind: 'os', id: 'first' },
    providerOptions: {
      operatorCredential: { kind: 'credential-ref', reference: 'os:second' },
    },
    now,
  })
  registry.save(record)
  const removed: string[] = []
  const controller = new ConnectionController({
    registry,
    providers: [],
    credentials: {
      async store() {
        throw new Error('not used')
      },
      async resolve() {
        throw new Error('not used')
      },
      async remove(reference) {
        removed.push(reference.id)
      },
    },
    now: () => now,
  })
  await assert.rejects(
    controller.remove('multi-credential', {
      activeRuns: [],
      detachedRuns: [],
      environments: [],
      credentialReferences: [],
    }),
    /atomically/u,
  )
  assert.deepEqual(removed, [])
  assert.notEqual(registry.get('multi-credential'), undefined)
})

test('secret handles claim once before concurrent callbacks start', async () => {
  const gate = new Promise<void>((resolve) => setTimeout(resolve, 20))
  process.env.BRAID_W7_SECRET_HANDLE = 'concurrent-secret'
  const handle = await new EnvironmentCredentialStore().resolve({
    kind: 'env',
    id: 'BRAID_W7_SECRET_HANDLE',
  })
  const results = await Promise.allSettled([
    handle.use(async () => {
      await gate
      return 'first'
    }),
    handle.use(async () => 'second'),
  ])
  delete process.env.BRAID_W7_SECRET_HANDLE
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
})

test('invalid secret callbacks do not consume the one-shot handle', async () => {
  process.env.BRAID_W7_SECRET_HANDLE_INVALID_CALLBACK = 'still-available'
  try {
    const handle = await new EnvironmentCredentialStore().resolve({
      kind: 'env',
      id: 'BRAID_W7_SECRET_HANDLE_INVALID_CALLBACK',
    })
    await assert.rejects(
      handle.use(null as unknown as (value: string) => Promise<string>),
      /operation must be a function/u,
    )
    assert.equal(await handle.use(async (value) => value), 'still-available')
  } finally {
    delete process.env.BRAID_W7_SECRET_HANDLE_INVALID_CALLBACK
  }
})

test('connection setup has separate bounded timeout and cancellation outcomes', async () => {
  const hanging: ConnectionProviderPort = {
    kind: 'cli-bridge',
    async health() {
      return new Promise<ConnectionHealth>(() => undefined)
    },
    async capabilities() {
      return capabilities()
    },
  }
  const timeoutController = new ConnectionController({
    registry: new ConnectionRegistry(),
    providers: [hanging],
    setupTimeoutMs: 15,
    now: () => now,
  })
  await assert.rejects(
    timeoutController.setup({
      id: 'timeout',
      kind: 'cli-bridge',
      name: 'timeout',
      endpoint: 'http://127.0.0.1:7331',
      now,
    }),
    ConnectionSetupTimeoutError,
  )
  const abortController = new ConnectionController({
    registry: new ConnectionRegistry(),
    providers: [hanging],
    setupTimeoutMs: 1_000,
    now: () => now,
  })
  const signal = new AbortController()
  const pending = abortController.setup(
    { id: 'cancel', kind: 'cli-bridge', name: 'cancel', endpoint: 'http://127.0.0.1:7331', now },
    { signal: signal.signal },
  )
  signal.abort()
  await assert.rejects(pending, ConnectionSetupCancelledError)
})

test('HTTP transport cannot return success after response cancellation', async () => {
  const controller = new AbortController()
  let releaseBody!: () => void
  const bodyBlocked = new Promise<void>((resolve) => {
    releaseBody = resolve
  })
  const transport = new FetchConnectionHttpTransport({
    fetchImpl: (async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{}'))
          },
          pull() {
            return bodyBlocked
          },
          cancel() {
            releaseBody()
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
  })
  const pending = transport.request({
    connection: connection(),
    path: '/health',
    method: 'GET',
    signal: controller.signal,
  })
  await wait(10)
  controller.abort()
  await assert.rejects(pending, ProviderRequestAbortedError)
})

test('connection profile validation detaches hostile values before provider code', async () => {
  const registry = new ConnectionRegistry()
  registry.save(connection())
  let providerCalls = 0
  const provider: ConnectionProviderPort = {
    ...providerWith(capabilities()),
    async validateProfile() {
      providerCalls += 1
      return { ok: true, issues: [] }
    },
  }
  const controller = new ConnectionController({
    registry,
    providers: [provider],
    now: () => now,
  })
  const hostile = { ...defineAgentProfile({ name: 'hostile-validation-input' }) }
  Object.defineProperty(hostile, 'description', {
    enumerable: true,
    get() {
      throw new Error('description getter executed')
    },
  })
  await assert.rejects(
    controller.validateProfile('bridge', hostile as never),
    /accessor/u,
  )
  assert.equal(providerCalls, 0)
})

test('capability payloads reject secret-shaped fields before transport redaction', async () => {
  const transport = new FetchConnectionHttpTransport({
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          environment,
          runners: ['claude-code'],
          models: ['Bearer sk-secret-model-12345678'],
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
  })
  const provider = createCliBridgeProvider(transport)
  await assert.rejects(provider.capabilities(connection()), /secret material|invalid/u)

  const bypassAttempt = new HttpConnectionProvider({
    kind: 'cli-bridge',
    transport: {
      async request() {
        return {
          status: 200,
          payload: {
            environment,
            supportedRunners: ['claude-code'],
            modelIds: ['model'],
            modelReasoning: {},
            digest: `sha256:${'0'.repeat(64)}`,
          },
        }
      },
    },
  })
  await assert.rejects(
    bypassAttempt.capabilities(connection()),
    /complete capability snapshot|digest/u,
  )
})

test('direct provider capability snapshots are bounded before digesting', () => {
  const hostile = {
    ...capabilities(),
    environment: {
      ...environment,
      profile: {
        ...environment.profile,
        extensions: Array.from({ length: 4_097 }, () => 'oversized'),
      },
    },
  }
  assert.throws(() => withCapabilityDigest(hostile), /more than 4096 entries/u)
  const accessor = { ...capabilities() } as Record<string, unknown>
  Object.defineProperty(accessor, 'digest', {
    enumerable: true,
    get() {
      throw new Error('digest getter executed')
    },
  })
  assert.throws(() => withCapabilityDigest(accessor as never), /accessor/u)
  assert.throws(
    () =>
      withCapabilityDigest({
        environment: { profile: {} },
        supportedRunners: [],
        modelIds: [],
        modelReasoning: {},
        retrievedAt: now,
        source: 'malformed',
      } as never),
    /namedProfiles/u,
  )
  assert.throws(
    () =>
      withCapabilityDigest({
        ...capabilities(),
        environment: { ...environment, futureField: 'secret' },
      } as never),
    /unsupported field/u,
  )
  const normalized = withCapabilityDigest(capabilities())
  assert.throws(() => {
    ;(normalized.environment.profile as { namedProfiles: boolean }).namedProfiles = false
  }, TypeError)
})

test('canonical and redacted provider values do not execute accessors or walk cycles', () => {
  const accessor = {} as Record<string, unknown>
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      throw new Error('accessor executed')
    },
  })
  assert.throws(() => canonicalDigest(accessor), /accessor/u)
  assert.deepEqual(redactProviderValue(accessor), { secret: '[redacted]' })
  const hidden = {} as Record<string, unknown>
  Object.defineProperty(hidden, 'name', { value: 'hidden', enumerable: false })
  assert.throws(() => canonicalDigest(hidden), /hidden/u)

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.deepEqual(redactProviderValue(cyclic), { self: '[redacted]' })
})

test('trustedTunnel explicitly permits an operator-attested remote bridge', () => {
  assert.doesNotThrow(() =>
    createConnectionRecord({
      id: 'remote-tunnel',
      kind: 'cli-bridge',
      name: 'remote tunnel',
      endpoint: 'http://10.0.0.7:7331',
      providerOptions: { trustedTunnel: true },
      now,
    }),
  )
  assert.throws(
    () =>
      createConnectionRecord({
        id: 'remote-plain',
        kind: 'cli-bridge',
        name: 'remote plain',
        endpoint: 'http://10.0.0.7:7331',
        now,
      }),
    /HTTPS outside loopback/u,
  )
  assert.throws(
    () => validateProviderOptions('tangle-sandbox', { maxConcurrentRuns: 0 }),
    /maxConcurrentRuns/u,
  )
  assert.throws(
    () => validateProviderOptions('tangle-sandbox', { maxConcurrentRuns: 1.5 }),
    /maxConcurrentRuns/u,
  )
})

test('programmatic profiles and descriptor reads reject oversized hostile input', async () => {
  let deep: Record<string, unknown> = {}
  for (let index = 0; index < 80; index += 1) deep = { child: deep }
  assert.equal(validateCanonicalProfile(deep).ok, false)
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-bounds-'))
  try {
    const path = join(directory, 'large.json')
    await writeFile(path, 'x'.repeat(1_048_577))
    await assert.rejects(readFileIdentity(path, { maxBytes: 1_048_576 }), /limit/u)
    const cyclic = {} as Record<string, unknown>
    cyclic.providerOptions = cyclic
    assert.throws(
      () => validateConnectionRecord(cyclic as never),
      /oversized or not JSON data|acyclic/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('structured profile views reject accessors and invalid page bounds', () => {
  const accessor = {} as Record<string, unknown>
  Object.defineProperty(accessor, 'name', {
    enumerable: true,
    get() {
      throw new Error('profile getter executed')
    },
  })
  assert.throws(() => immutableProfileValue(accessor), /accessor/u)
  assert.throws(() => structuredProfilePage({ name: 'profile' }, { offset: Number.NaN }), /bounds/u)
})

test('profile source trees and profile view models are detached and immutable', () => {
  const profile = {
    ...defineAgentProfile({ name: 'immutable' }),
    model: { default: 'fixture/model' },
  }
  const document = profileDocumentFromJson(JSON.stringify(profile), {
    kind: 'inline',
    value: 'inline',
    label: 'inline',
    writable: false,
  })
  const fullValue = document.fullValue as { model: { default: string } }
  assert.equal(fullValue.model.default, 'fixture/model')
  assert.throws(() => {
    fullValue.model.default = 'changed'
  }, TypeError)
  assert.equal(fullValue.model.default, 'fixture/model')

  const view = freezeProfileViewModel({
    profiles: [
      {
        reference: 'inline:profile',
        name: 'immutable',
        tags: ['one'],
        source: 'inline',
        writable: false,
        unrecognizedFields: [],
        validation: 'valid',
      },
    ],
    connections: [
      {
        id: 'bridge',
        kind: 'cli-bridge',
        name: 'bridge',
        health: { status: 'healthy', checkedAt: now },
        credentialConfigured: false,
      },
    ],
  })
  const profileItem = view.profiles.at(0)
  const connectionItem = view.connections.at(0)
  assert.ok(profileItem)
  assert.ok(connectionItem)
  assert.ok(connectionItem.health)
  assert.throws(() => {
    ;(profileItem.tags as string[]).push('changed')
  }, TypeError)
  assert.throws(() => {
    ;(connectionItem.health as { status: string }).status = 'unknown'
  }, TypeError)
})

test('loaded profile values are bounded before canonicalization', async () => {
  const adapter = new LoadedProfileSourceAdapter({
    kind: 'configured',
    canResolve: () => true,
    async resolve() {
      return {
        value: {
          name: 'loaded',
          futureField: Array.from({ length: 4_097 }, () => 'oversized'),
        },
      }
    },
  })
  await assert.rejects(adapter.resolve('configured://hostile'), /more than 4096 entries/u)
})

test('programmatic admission controls are bounded before provider calls', async () => {
  let capabilityCalls = 0
  const admission = new RunAdmissionController({
    provider: {
      ...providerWith(capabilities()),
      async capabilities(connection, options) {
        capabilityCalls += 1
        return providerWith(capabilities()).capabilities(connection, options)
      },
    },
    runtime: {
      async confirmCapabilities() {},
      async admit(input) {
        return receipt(input)
      },
    },
    receipts: new MemoryReceiptStore(),
    now: () => now,
  })
  await assert.rejects(
    admission.prepare({
      identifiers: {
        operationId: 'bounded-controls',
        turnId: 'turn',
        branchId: 'branch',
        conversationId: 'conversation',
      },
      source: source(defineAgentProfile({ name: 'bounded-controls' })),
      connection: connection(),
      overrides: { model: 'x'.repeat(4_097) },
    }),
    /oversized|not JSON data/u,
  )
  await assert.rejects(
    admission.prepare({
      identifiers: {
        operationId: 'duplicate-warning-codes',
        turnId: 'turn',
        branchId: 'branch',
        conversationId: 'conversation',
      },
      source: source(defineAgentProfile({ name: 'duplicate-warning-codes' })),
      connection: connection(),
      acceptedWarningCodes: ['warning', 'warning'],
    }),
    /duplicates/u,
  )
  assert.equal(capabilityCalls, 0)
})

test('programmatic runner and effort overrides use canonical values', async () => {
  const admission = new RunAdmissionController({
    provider: providerWith(capabilities()),
    runtime: {
      async confirmCapabilities() {},
      async admit(input) {
        return receipt(input)
      },
    },
    receipts: new MemoryReceiptStore(),
    now: () => now,
  })
  const base = {
    identifiers: {
      operationId: 'canonical-overrides',
      turnId: 'turn',
      branchId: 'branch',
      conversationId: 'conversation',
    },
    source: source(defineAgentProfile({ name: 'canonical-overrides' })),
    connection: connection(),
  }
  await assert.rejects(
    admission.prepare({ ...base, overrides: { runner: 'not-a-runner' } as never }),
    /canonical runner/u,
  )
  await assert.rejects(
    admission.prepare({ ...base, overrides: { effort: 'not-an-effort' } as never }),
    /canonical reasoning effort/u,
  )
})

test('the composed application sends through admission before the runtime stream', async () => {
  const profile = defineAgentProfile({ name: 'composed' })
  const blocked = profileDocumentFromJson(JSON.stringify({ ...profile, futureField: true }), {
    kind: 'local-file',
    value: '/tmp/composed.json',
    label: 'composed',
    writable: true,
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    profile: blocked.profile,
    profileDocument: blocked,
  })
  app.initialize('/workspace')
  const result = app.send({ operationId: 'composed-block', text: 'must not run' })
  await result.completion
  assert.equal(app.state().runs[0]?.status, 'failed')
  assert.match(app.state().lastError ?? '', /save-blocked|cannot be safely saved/u)
})

test('the full composed send path performs health, capability binding, and materialization', async () => {
  let healthCalls = 0
  let capabilityCalls = 0
  let confirmations = 0
  let materializations = 0
  const provider: ConnectionProviderPort = {
    kind: 'cli-bridge',
    async health() {
      healthCalls += 1
      return { status: 'healthy', checkedAt: now }
    },
    async capabilities() {
      capabilityCalls += 1
      return {
        ...capabilities(),
        supportedRunners: ['pi'],
        modelIds: ['fixture/deterministic'],
      }
    },
  }
  const runtime: RunAdmissionPort = {
    async confirmCapabilities() {
      confirmations += 1
    },
    async admit(input) {
      materializations += 1
      return receipt(input)
    },
  }
  const app = createBraidApplication({
    fixture: 'deterministic',
    provider,
    connection: connection(),
    runtime,
  })
  app.initialize('/workspace')
  const state = await app.send({ operationId: 'full-composed', text: 'through admission' })
    .completion
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(healthCalls, 1)
  assert.equal(capabilityCalls, 2)
  assert.equal(confirmations, 1)
  assert.equal(materializations, 1)
})

test('the binary composition persists admission receipts and replays after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-w7-composed-persistence-'))
  const storage = join(directory, 'admission')
  try {
    const first = createBraidApplication({
      fixture: 'deterministic',
      admissionStorageDirectory: storage,
    })
    first.initialize(directory)
    await first.send({ operationId: 'composed-restart', text: 'persist this turn' }).completion
    assert.equal(
      await access(join(storage, 'receipts.json')).then(
        () => true,
        () => false,
      ),
      true,
    )
    assert.equal(
      await access(join(storage, 'ledger.json')).then(
        () => true,
        () => false,
      ),
      true,
    )

    const restarted = createBraidApplication({
      fixture: 'deterministic',
      admissionStorageDirectory: storage,
    })
    restarted.initialize(directory)
    const replay = await restarted.send({
      operationId: 'composed-restart',
      text: 'persist this turn',
    }).completion
    assert.equal(replay.runs[0]?.status, 'completed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
