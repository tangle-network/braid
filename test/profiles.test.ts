import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type AgentProfile,
  type AgentProfileCapabilities,
  canonicalAgentProfileDigest,
  canonicalCandidateJson,
  defineAgentProfilePublicConfig,
  defineAgentProfileSecretRef,
} from '@tangle-network/agent-interface'
import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface/environment-provider'
import {
  AGENT_INTERFACE_PACKAGE_VERSION,
  createProfileRecord,
  createProfileSnapshot,
  discoverProfiles,
  exportProfileDocument,
  exportProfileFile,
  exportProfileJson,
  importProfileJson,
  importProfileSource,
  ProfileCatalog,
  ProfileDraft,
  ProfilePersistenceError,
  ProfileValidationError,
  readProfileFile,
  resolveEffectiveProfile,
  resolveProfileSource,
  saveProfileFile,
  searchProfiles,
  selectBaseProfile,
  validateProfile,
  validateProfileShape,
} from '../src/app/profiles.js'

const profileCapabilities: AgentProfileCapabilities = {
  namedProfiles: true,
  systemPrompt: { replace: true, append: true },
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
  runtimeUpdate: true,
  validation: true,
  extensions: ['future.backend'],
}

const environmentCapabilities: AgentEnvironmentCapabilities = {
  profile: profileCapabilities,
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, list: true, messages: true },
  workspace: {
    read: true,
    write: true,
    exec: true,
    git: true,
    upload: true,
    download: true,
  },
  branching: { checkpoint: true, fork: true, retrySafe: true, lookup: true, cleanup: true },
  placement: true,
  usage: true,
  confidential: false,
}

const fullProfile: AgentProfile = {
  name: 'reviewer',
  description: 'Reviews durable integration work',
  version: '2.1.0',
  tags: ['review', 'integration'],
  prompt: {
    systemPrompt: 'You are a careful reviewer.',
    instructions: ['Keep evidence attached.', 'Do not guess.'],
  },
  model: {
    default: 'anthropic/claude-sonnet',
    small: 'anthropic/claude-haiku',
    provider: 'anthropic',
    reasoningEffort: 'high',
    metadata: { contextWindow: 200000, family: 'sonnet' },
  },
  harness: 'claude-code',
  permissions: {
    shell: { read: 'allow', write: 'ask' },
    network: 'deny',
  },
  tools: { read: true, write: true, web_search: false },
  mcp: {
    local: {
      transport: 'stdio',
      command: 'mcp-review',
      args: [defineAgentProfilePublicConfig('--safe')],
      env: { REVIEW_TOKEN: defineAgentProfileSecretRef('cred:v1:review-token') },
      cwd: 'workspace',
      metadata: { owner: 'team-review' },
    },
    remote: {
      transport: 'http',
      url: 'https://mcp.example.com',
      headers: {
        Authorization: defineAgentProfileSecretRef('cred:v1:mcp-auth', 'bearer'),
      },
    },
    disabled: { enabled: false },
  },
  connections: [{ connectionId: 'hub-github', capabilities: ['repo.read'], alias: 'github' }],
  subagents: {
    tester: {
      description: 'Runs focused tests',
      prompt: 'Test the smallest meaningful surface.',
      model: 'anthropic/claude-haiku',
      tools: { read: true },
      permissions: { shell: 'ask' },
      maxSteps: 4,
      metadata: { role: 'test' },
    },
  },
  resources: {
    files: [
      {
        path: 'REVIEW.md',
        resource: { kind: 'inline', name: 'review', content: 'Review rules.' },
        executable: false,
      },
    ],
    tools: [{ kind: 'inline', name: 'tool', content: 'Tool definition.' }],
    skills: [
      { kind: 'github', repository: 'tangle-network/skills', path: 'review/SKILL.md', ref: 'main' },
    ],
    agents: [{ kind: 'inline', name: 'agent', content: 'Agent definition.' }],
    commands: [{ kind: 'inline', name: 'check', content: 'Check definition.' }],
    instructions: { kind: 'inline', name: 'instructions', content: 'Additional rules.' },
    failOnError: true,
  },
  hooks: {
    beforeTurn: [
      {
        command: 'review-hook',
        timeoutMs: 1000,
        blocking: true,
        matcher: '.*',
        env: { MODE: defineAgentProfilePublicConfig('review') },
      },
    ],
  },
  modes: {
    fast: {
      description: 'Short review',
      model: 'anthropic/claude-haiku',
      prompt: 'Be concise.',
      tools: { read: true },
      permissions: { shell: 'deny' },
      metadata: { budget: 'small' },
    },
  },
  confidential: {
    tee: 'tdx',
    attestationNonce: 'a'.repeat(64),
    sealed: true,
    attestationRefresh: true,
  },
  metadata: { owner: 'braid', note: 'public profile metadata', apiKey: 'do-not-persist' },
  extensions: {
    'future.backend': {
      unknownField: { preserved: true },
      anotherValue: 'round-trip',
    },
  },
}

const localSecurity = {
  allowLocalMcp: true,
  allowHooks: true,
  allowedMcpHosts: ['mcp.example.com'],
}

function source(
  reference: string,
  profile: AgentProfile = fullProfile,
  kind: 'inline' | 'file' = 'inline',
) {
  return createProfileRecord(
    {
      kind,
      reference,
      label: reference,
      writable: kind === 'file',
      trusted: true,
    },
    profile,
  )
}

test('the installed canonical profile schema round-trips every field and extensions', () => {
  const shape = validateProfileShape(fullProfile)
  assert.equal(shape.ok, true)
  assert.ok(shape.profile)
  assert.equal(shape.digest, canonicalAgentProfileDigest(shape.profile))

  const json = canonicalCandidateJson(shape.profile)
  const imported = importProfileJson(json)
  assert.equal(imported.redacted, false)
  assert.equal(canonicalCandidateJson(imported.profile), json)
  assert.deepEqual(imported.profile.extensions, fullProfile.extensions)
  assert.deepEqual(imported.profile.resources, fullProfile.resources)
  assert.equal(AGENT_INTERFACE_PACKAGE_VERSION, '1.0.0')
})

test('unknown canonical fields fail closed while namespaced extensions remain opaque', () => {
  const invalid = { ...fullProfile, futureCanonicalField: true }
  const result = validateProfileShape(invalid)
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((item) => item.code === 'unrecognized_keys'))

  const document = exportProfileDocument(fullProfile, { redact: false })
  const imported = importProfileJson(JSON.stringify(document), { allowRedacted: true })
  assert.deepEqual(imported.profile.extensions?.['future.backend'], {
    unknownField: { preserved: true },
    anotherValue: 'round-trip',
  })
})

test('provider validation blocks errors and requires exact acceptance of warnings', async () => {
  const publicProfile = {
    ...fullProfile,
    metadata: { owner: 'braid', note: 'public profile metadata' },
  }
  const provider = {
    name: 'test-provider',
    capabilities: () => environmentCapabilities,
    validateProfile: () => ({
      ok: true,
      issues: [
        {
          level: 'warning' as const,
          code: 'model-snapped',
          message: 'Provider will use its selected model',
          path: 'model.default',
        },
      ],
      normalizedProfile: {
        ...publicProfile,
        model: { ...publicProfile.model, default: 'anthropic/claude-haiku' },
      },
    }),
  }
  const rejected = await validateProfile(publicProfile, {
    securityPolicy: localSecurity,
    provider,
  })
  assert.equal(rejected.ok, false)
  assert.ok(rejected.issues.some((item) => item.code === 'provider-warning-not-accepted'))

  const accepted = await validateProfile(publicProfile, {
    securityPolicy: localSecurity,
    provider,
    acceptedProviderWarningCodes: ['model-snapped'],
  })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.profile?.model?.default, 'anthropic/claude-haiku')
  assert.equal(accepted.provider?.result.issues[0]?.code, 'model-snapped')
  assert.deepEqual(accepted.acceptedProviderWarningCodes, ['model-snapped'])

  const inlineSecret = await validateProfile(fullProfile, {
    securityPolicy: localSecurity,
    provider,
    acceptedProviderWarningCodes: ['model-snapped'],
  })
  assert.equal(inlineSecret.ok, false)
  assert.ok(inlineSecret.issues.some((item) => item.code === 'inline-secret-forbidden'))
})

test('selection precedence and run overrides never mutate the source profile', () => {
  const command = source('command', { ...fullProfile, name: 'command' })
  const branch = source('branch', { ...fullProfile, name: 'branch' })
  const workspace = source('workspace', { ...fullProfile, name: 'workspace' })
  const user = source('user', { ...fullProfile, name: 'user' })
  const first = source('first', { ...fullProfile, name: 'first' })

  assert.equal(
    selectBaseProfile({
      commandLine: command,
      branch,
      workspace,
      user,
      firstRun: first,
      workspaceTrusted: true,
    })?.reason,
    'command-line',
  )
  assert.equal(
    selectBaseProfile({ branch, workspace, user, firstRun: first, workspaceTrusted: true })?.reason,
    'branch',
  )
  assert.equal(
    selectBaseProfile({ workspace, user, firstRun: first, workspaceTrusted: true })?.reason,
    'workspace',
  )
  assert.equal(
    selectBaseProfile({ workspace, user, firstRun: first, workspaceTrusted: false })?.reason,
    'user',
  )

  const effective = resolveEffectiveProfile({
    profile: command,
    branchOverrides: {
      model: 'openai/gpt-5',
      effort: 'medium',
      connectionId: 'branch-connection',
    },
    nextRunOverrides: {
      harness: 'codex',
      model: 'openai/gpt-5.6',
      effort: 'xhigh',
      mode: 'fast',
      connectionId: 'next-connection',
    },
  })
  assert.equal(effective.runner, 'codex')
  assert.equal(effective.model, 'openai/gpt-5.6')
  assert.equal(effective.effort, 'xhigh')
  assert.equal(effective.mode, 'fast')
  assert.equal(effective.connectionId, 'next-connection')
  assert.equal(effective.effectiveProfile.model?.small, fullProfile.model?.small)
  assert.equal(command.profile.model?.default, fullProfile.model?.default)
  assert.equal(effective.compatibility.modelSupported, true)

  assert.equal(
    resolveEffectiveProfile({
      profile: command,
      workspaceTrusted: false,
      workspaceConnectionId: 'workspace-connection',
      userConnectionId: 'user-connection',
    }).connectionId,
    'user-connection',
  )
  assert.equal(
    resolveEffectiveProfile({
      profile: command,
      workspaceTrusted: true,
      workspaceConnectionId: 'workspace-connection',
      userConnectionId: 'user-connection',
    }).connectionId,
    'workspace-connection',
  )
})

test('drafts validate raw and structured edits immediately and produce canonical diffs', () => {
  const draft = new ProfileDraft(fullProfile)
  assert.equal(draft.valid, true)
  const invalid = draft.replaceRaw('{"name":')
  assert.equal(invalid.ok, false)
  assert.throws(() => draft.profile, ProfileValidationError)

  const valid = draft.replace({ ...fullProfile, name: 'edited' })
  assert.equal(valid.ok, true)
  assert.equal(draft.profile.name, 'edited')
  assert.ok(draft.diff().length > 0)
  assert.match(draft.rawJson(), /"name":"edited"/u)
})

test('discovery is ordered, explicit, source-distinct, and does not scan untrusted workspace entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-profiles-discovery-'))
  try {
    const path = join(root, 'workspace.json')
    await writeFile(path, canonicalCandidateJson({ ...fullProfile, name: 'file-profile' }))
    const result = await discoverProfiles({
      explicit: [
        { kind: 'inline', reference: 'explicit', profile: { ...fullProfile, name: 'explicit' } },
      ],
      workspace: [{ kind: 'file', reference: path, path }],
      workspaceTrusted: false,
      user: [{ kind: 'inline', reference: 'user', profile: { ...fullProfile, name: 'user' } }],
      provider: [
        {
          kind: 'provider',
          reference: 'catalog/reviewer',
          resolve: async () => ({ ...fullProfile, name: 'provider' }),
        },
      ],
    })
    assert.deepEqual(
      result.profiles.map((item) => item.displayName),
      ['explicit', 'user', 'provider'],
    )
    assert.equal(result.issues.length, 0)

    const duplicates = await discoverProfiles({
      explicit: [
        { kind: 'inline', reference: 'one', profile: fullProfile },
        { kind: 'inline', reference: 'two', profile: fullProfile },
      ],
    })
    assert.equal(duplicates.profiles.length, 2)
    assert.notEqual(duplicates.profiles[0]?.id, duplicates.profiles[1]?.id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('search covers runner, tools, skills, and connection capability fields', () => {
  const record = source('searchable')
  assert.equal(searchProfiles([record], 'claude-code').length, 1)
  assert.equal(searchProfiles([record], 'review').length, 1)
  assert.equal(searchProfiles([record], 'review/SKILL.md').length, 1)
  assert.equal(searchProfiles([record], 'repo.read').length, 1)
  assert.equal(searchProfiles([record], 'does-not-exist').length, 0)
  const catalog = new ProfileCatalog({ profiles: [record] })
  assert.equal(catalog.size, 1)
  assert.equal(catalog.get(record.id)?.id, record.id)
})

test('profile snapshots are immutable, redacted, and carry provider-safe receipt data', () => {
  const record = source('snapshot')
  const effective = resolveEffectiveProfile({
    profile: record,
    nextRunOverrides: { model: 'anthropic/claude-haiku', effort: 'low' },
  })
  const validation = {
    ok: true,
    issues: [],
    profile: effective.effectiveProfile,
    digest: canonicalAgentProfileDigest(effective.effectiveProfile),
    acceptedProviderWarningCodes: ['model-snapped'],
  }
  const receipt = createProfileSnapshot({
    source: record,
    effective,
    validation,
    capabilities: profileCapabilities,
    providerMaterializationReceipt: {
      materializationDigest: 'sha256:materialization',
      metadata: { apiKey: 'do-not-persist' },
    },
  })
  assert.equal(Object.isFrozen(receipt), true)
  assert.equal(Object.isFrozen(receipt.effectiveProfile), true)
  assert.equal(receipt.effectiveProfile.confidential?.attestationNonce, '[redacted challenge]')
  assert.deepEqual(receipt.effectiveProfile.metadata, { redacted: '[redacted]' })
  assert.deepEqual(receipt.effectiveProfile.model?.metadata, { redacted: '[redacted]' })
  assert.deepEqual(receipt.effectiveProfile.mcp?.local?.metadata, { redacted: '[redacted]' })
  assert.deepEqual(receipt.effectiveProfile.subagents?.tester?.metadata, {
    redacted: '[redacted]',
  })
  assert.deepEqual(receipt.effectiveProfile.modes?.fast?.metadata, { redacted: '[redacted]' })
  assert.deepEqual(receipt.validation.acceptedProviderWarningCodes, ['model-snapped'])
  assert.equal(JSON.stringify(receipt).includes('do-not-persist'), false)
  assert.equal(
    receipt.effectiveProfileDigest,
    canonicalAgentProfileDigest(effective.effectiveProfile),
  )
  assert.notEqual(
    receipt.effectiveProfileDigest,
    canonicalAgentProfileDigest(receipt.effectiveProfile),
  )
})

test('profile files save atomically, verify bytes, reject races and symlinks, and export safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-profiles-files-'))
  try {
    const path = join(root, 'reviewer.json')
    const saved = saveProfileFile(path, fullProfile, { trusted: true })
    assert.equal((await lstat(path)).mode & 0o777, 0o600)
    assert.equal(readProfileFile(path).bytesDigest, saved.bytesDigest)
    assert.equal(readProfileFile(path).imported.digest, canonicalAgentProfileDigest(fullProfile))

    await writeFile(path, '{"name":"changed"}')
    assert.throws(
      () => saveProfileFile(path, fullProfile, { expectedBytesDigest: saved.bytesDigest }),
      (error: unknown) =>
        error instanceof ProfilePersistenceError && error.code === 'PROFILE_SOURCE_CHANGED',
    )

    const exportPath = join(root, 'reviewer.export.json')
    const exported = exportProfileFile(exportPath, fullProfile)
    const exportText = await readFile(exportPath, 'utf8')
    assert.equal(exportText.includes('do-not-persist'), false)
    assert.equal(exported.document.redacted, true)
    assert.throws(() => importProfileJson(exportText), ProfilePersistenceError)
    const acknowledged = importProfileJson(exportText, { allowRedacted: true })
    assert.equal(acknowledged.digest, exported.document.profileDigest)
    assert.deepEqual(acknowledged.profile.metadata, { redacted: '[redacted]' })
    assert.deepEqual(acknowledged.profile.model?.metadata, { redacted: '[redacted]' })
    assert.deepEqual(acknowledged.profile.mcp?.local?.metadata, { redacted: '[redacted]' })
    assert.throws(
      () => exportProfileFile(exportPath, fullProfile),
      (error: unknown) =>
        error instanceof ProfilePersistenceError && error.code === 'PROFILE_EXISTS',
    )
    assert.deepEqual(acknowledged.profile.extensions?.['future.backend'], {
      unknownField: { preserved: true },
      anotherValue: 'round-trip',
    })

    const exact = importProfileJson(exportProfileJson(fullProfile, { redact: false }), {
      allowRedacted: true,
    })
    assert.equal(canonicalCandidateJson(exact.profile), canonicalCandidateJson(fullProfile))

    const link = join(root, 'planted.json')
    const target = join(root, 'target.json')
    await writeFile(target, '{}')
    await symlink(target, link)
    assert.throws(
      () => saveProfileFile(link, fullProfile),
      (error: unknown) => error instanceof Error && /symbolic link/u.test(error.message),
    )
    assert.equal((await readFile(target, 'utf8')) === '{}', true)

    const directoryPath = join(root, 'directory')
    await mkdir(directoryPath)
    assert.throws(
      () => saveProfileFile(directoryPath, fullProfile),
      (error: unknown) =>
        error instanceof ProfilePersistenceError && error.code === 'PROFILE_FILE_NOT_REGULAR',
    )

    const readonlyPath = join(root, 'readonly.json')
    await writeFile(readonlyPath, canonicalCandidateJson(fullProfile))
    await chmod(readonlyPath, 0o400)
    const imported = await resolveProfileSource({
      kind: 'file',
      reference: readonlyPath,
      path: readonlyPath,
      writable: false,
    })
    assert.equal(imported.source.writable, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('inline import preserves the source descriptor without merging profiles', () => {
  const record = importProfileSource(fullProfile, {
    kind: 'package',
    reference: '@example/reviewer',
    label: 'package reviewer',
    writable: false,
    trusted: true,
  })
  assert.equal(record.source.kind, 'package')
  assert.equal(record.source.writable, false)
  assert.equal(record.profile.name, 'reviewer')
})
