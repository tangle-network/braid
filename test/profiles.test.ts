import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type AgentProfile,
  canonicalAgentProfileDigest,
  canonicalCandidateJson,
  defineAgentProfilePublicConfig,
  defineAgentProfileSecretRef,
} from '@tangle-network/agent-interface'
import {
  AGENT_INTERFACE_PACKAGE_VERSION,
  discoverProfiles,
  exportProfileFile,
  exportProfileJson,
  importProfileJson,
  ProfilePersistenceError,
  readProfileFile,
  resolveProfileSource,
  saveProfileFile,
  validateProfileShape,
} from '../src/app/profiles.js'

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

test('the installed canonical profile schema round-trips every field and extensions', async () => {
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
  // The resolved package must be the exact cohort this repository pins.
  const pinned = (
    JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      readonly dependencies: Readonly<Record<string, string>>
    }
  ).dependencies['@tangle-network/agent-interface']
  assert.equal(AGENT_INTERFACE_PACKAGE_VERSION, pinned)
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
