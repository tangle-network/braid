import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  ConfigurationSession,
  ConfigurationSessionError,
} from '../src/app/configuration-session.js'
import { createProfileRecord } from '../src/app/profiles.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'

const at = '2026-08-03T20:00:00.000Z'

function profile(name: string, model: string): AgentProfile {
  return {
    name,
    prompt: { systemPrompt: `You are ${name}.` },
    model: { default: model },
    harness: 'pi',
  }
}

function profileRecord(name: string, model: string) {
  return createProfileRecord(
    {
      kind: 'inline',
      reference: `test:${name}`,
      label: `${name} profile`,
      writable: false,
      trusted: true,
    },
    profile(name, model),
  )
}

function connection(
  kind: ConnectionRecord['kind'],
  name: string,
  credentialRef?: ConnectionRecord['credentialRef'],
): ConnectionRecord {
  return {
    id: createConnectionId(`connection-${name}`),
    kind,
    name,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    providerOptions: {
      transport: kind === 'cli-bridge' ? 'local' : 'https',
      capabilityHints: ['stream', 'usage'],
    },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}

test('configuration session chooses a profile and connection without persisting credentials', () => {
  const reviewer = profileRecord('reviewer', 'openai/gpt-5.6')
  const coder = profileRecord('coder', 'anthropic/claude-sonnet')
  const cli = connection('cli-bridge', 'local-cli', 'credential-secret-ref')
  const inference = connection('tangle-inference', 'cloud-inference', 'credential-cloud-ref')
  const sandbox = connection('tangle-sandbox', 'remote-sandbox', 'credential-sandbox-ref')
  const session = new ConfigurationSession({
    profiles: [reviewer, coder],
    connections: [sandbox, inference, cli],
  })

  assert.equal(session.state.step, 'profile')
  assert.deepEqual(
    session.state.profiles.map((item) => item.label),
    ['coder', 'reviewer'],
  )
  assert.deepEqual(
    session.state.connections.map((item) => item.kind),
    ['cli-bridge', 'tangle-inference', 'tangle-sandbox'],
  )
  assert.match(session.state.connections[0]?.description ?? '', /ready/u)
  assert.doesNotMatch(session.state.connections[0]?.description ?? '', /credential-secret-ref/u)

  session.selectProfile(reviewer.id)
  assert.equal(session.state.step, 'connection')
  session.selectConnection(sandbox.id)
  assert.equal(session.state.step, 'workspace')
  session.submitWorkspace({
    repoUrl: 'https://github.com/acme/repository',
    gitRef: 'main',
    cwd: { base: 'repository', path: 'src' },
  })
  assert.equal(session.state.step, 'confirm')
  const selected = session.confirm()

  assert.equal(session.state.step, 'complete')
  assert.equal(selected.profile.id, reviewer.id)
  assert.equal(selected.connection.id, sandbox.id)
  assert.equal(selected.connection.credentialRef, 'credential-sandbox-ref')
  assert.equal(selected.workspaceRequest?.repoUrl, 'https://github.com/acme/repository')
  assert.equal(Object.isFrozen(selected.workspaceRequest), true)
  assert.equal(Object.isFrozen(selected), true)
  assert.equal('error' in session.state, false)
  assert.throws(() => session.selectProfile(coder.id), ConfigurationSessionError)
})

test('local and inference connections skip cloud workspace setup', () => {
  const record = profileRecord('reviewer', 'openai/gpt-5.6')
  const session = new ConfigurationSession({
    profiles: [record],
    connections: [
      connection('cli-bridge', 'local-cli'),
      connection('tangle-inference', 'inference'),
    ],
  })
  session.selectProfile(record.id)
  session.selectConnection(session.state.connections[0]?.id ?? '')
  assert.equal(session.state.step, 'confirm')
  const failed = session.submitWorkspace({ cwd: { base: 'repository', path: '/workspace' } })
  assert.equal(failed.error?.code, 'CONNECTION_REQUIRED')
})

test('workspace validation keeps the session open and reports the bounded field error', () => {
  const record = profileRecord('reviewer', 'openai/gpt-5.6')
  const cloud = connection('tangle-sandbox', 'remote-sandbox')
  const session = new ConfigurationSession({ profiles: [record], connections: [cloud] })
  session.selectProfile(record.id)
  session.selectConnection(cloud.id)
  const failed = session.submitWorkspace({ gitRef: 'main' })
  assert.equal(failed.step, 'workspace')
  assert.equal(failed.error?.code, 'WORKSPACE_INVALID')
  assert.equal(failed.error?.message, 'gitRef requires repoUrl')

  const failedCwd = session.submitWorkspace({
    cwd: { base: 'repository', path: '/workspace/src' },
  })
  assert.equal(failedCwd.step, 'workspace')
  assert.equal(failedCwd.error?.code, 'WORKSPACE_INVALID')
  assert.equal(failedCwd.error?.message, 'start in must be a repository-relative path')
})

test('configuration session supports back navigation and fails closed on empty catalogs', () => {
  const session = new ConfigurationSession({ profiles: [], connections: [] })
  const profileResult = session.selectProfile('profile-missing')
  assert.equal(profileResult.error?.code, 'NO_PROFILES')
  assert.equal(session.state.step, 'profile')

  const record = profileRecord('reviewer', 'openai/gpt-5.6')
  const connectionRecord = connection('cli-bridge', 'local-cli')
  const configured = new ConfigurationSession({
    profiles: [record],
    connections: [connectionRecord],
  })
  configured.selectProfile(record.id)
  configured.selectConnection(connectionRecord.id)
  assert.equal(configured.back().step, 'connection')
  assert.equal(configured.back().step, 'profile')
  assert.equal(configured.state.error, undefined)
  assert.equal('error' in configured.state, false)
  assert.equal(configured.cancel().step, 'cancelled')
  assert.throws(() => configured.confirm(), ConfigurationSessionError)
})

test('a staged selection can be cancelled or retried after apply failure', () => {
  const record = profileRecord('reviewer', 'openai/gpt-5.6')
  const connectionRecord = connection('cli-bridge', 'local-cli')
  const session = new ConfigurationSession({
    profiles: [record],
    connections: [connectionRecord],
  })
  session.selectProfile(record.id)
  session.selectConnection(connectionRecord.id)
  const selection = session.confirm()
  assert.equal(session.confirm(), selection)
  assert.equal(session.back().step, 'connection')
  session.cancel()
  assert.equal(session.state.step, 'cancelled')
})

test('changing a choice after review cannot reuse the previous committed selection', () => {
  const reviewer = profileRecord('reviewer', 'openai/gpt-5.6')
  const coder = profileRecord('coder', 'anthropic/claude-sonnet')
  const connectionRecord = connection('cli-bridge', 'local-cli')
  const session = new ConfigurationSession({
    profiles: [reviewer, coder],
    connections: [connectionRecord],
  })

  session.selectProfile(reviewer.id)
  session.selectConnection(connectionRecord.id)
  const first = session.confirm()
  assert.equal(first.profile.id, reviewer.id)
  session.backTo('profile')
  session.selectProfile(coder.id)
  session.selectConnection(connectionRecord.id)
  const second = session.confirm()

  assert.equal(second.profile.id, coder.id)
  assert.notEqual(second.profile.id, first.profile.id)
})
