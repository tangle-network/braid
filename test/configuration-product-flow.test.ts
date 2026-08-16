import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { ConnectionSummary } from '../src/app/connection-action-types.js'
import { createProfileRecord } from '../src/app/profiles.js'
import type {
  BraidIntent,
  BraidUiController,
  UiDispatchResult,
} from '../src/views/shared/intents.js'
import type { BraidViewModel, HeadlessState } from '../src/views/shared/models.js'
import { profileDetailLines } from '../src/views/tui/configuration-presenters.js'
import { ConfigurationWizard } from '../src/views/tui/configuration-wizard.js'
import { ConnectionSetupViewPanel } from '../src/views/tui/connection-setup.js'
import { ProfileEditorViewPanel } from '../src/views/tui/profile-editor.js'
import { createBraidTheme } from '../src/views/tui/theme.js'

const at = '2026-08-04T00:00:00.000Z'
const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })

function profile(name: string, _writable: boolean): AgentProfile {
  return {
    name,
    description: `${name} profile`,
    prompt: { systemPrompt: `Work as ${name}.` },
    model: {
      default: `provider/${name.toLowerCase()}`,
      reasoningEffort: 'high',
      maxVisibleOutputTokens: 8192,
      maxReasoningTokens: 16_384,
      maxTotalOutputTokens: 24_576,
    },
    harness: 'pi',
    tools: { read: true },
    ...(_writable ? { metadata: { source: 'test' } } : {}),
  }
}

function profileSummary(name: string, writable: boolean) {
  return {
    id: `profile-${name.toLowerCase()}`,
    name,
    description: `${name} profile`,
    tags: [],
    source: {
      kind: 'file' as const,
      reference: '/workspace/.braid/profiles/secret-profile.json',
      label: 'workspace profile',
      writable,
      trusted: true,
    },
    digest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    runner: 'pi',
    model: `provider/${name.toLowerCase()}`,
    reasoningEffort: 'high',
    maxVisibleOutputTokens: 8192,
    maxReasoningTokens: 16_384,
    maxTotalOutputTokens: 24_576,
    tools: ['read'],
    skills: [],
    connections: [],
  }
}

function connectionSummary(name: string, id: string, ready = true): ConnectionSummary {
  return {
    id,
    name,
    kind: 'cli-bridge',
    endpoint: 'https://bridge.example.test/v1?access_token=secret-canary',
    credentialConfigured: true,
    health: { status: 'healthy', checkedAt: at },
    modelVerification: {
      model: 'provider/reviewer',
      status: 'verified',
      checkedAt: at,
    },
    capabilityHints: ['stream', 'usage'],
    ready,
  }
}

function accepted(data: unknown, revision = 8): UiDispatchResult {
  return { kind: 'accepted', revision, data }
}

function controllerFor(
  calls: BraidIntent[],
  options: { duplicateProfileName?: boolean; rejectLists?: boolean; singleProfile?: boolean } = {},
): BraidUiController {
  let currentView = {
    revision: 7,
    profileName: 'Reviewer',
    connection: 'Local Bridge',
  } as BraidViewModel
  const profiles = options.singleProfile
    ? [profileSummary('Reviewer', true)]
    : [profileSummary('Reviewer', true), profileSummary('ReadOnly', false)]
  if (options.duplicateProfileName) {
    profiles.push({ ...profileSummary('Reviewer', false), id: 'profile-reviewer-duplicate' })
  }
  const connections = [
    connectionSummary('Local Bridge', 'connection-local'),
    connectionSummary('Cloud Bridge', 'connection-cloud', false),
  ]
  const localConnection = connections[0]
  if (localConnection === undefined) throw new Error('test fixture missing local connection')
  return {
    view: () => currentView,
    state: () => ({}) as HeadlessState,
    events: () => [],
    initialize: async () => accepted(undefined),
    subscribe: () => () => {},
    dispatch: async (intent) => {
      calls.push(intent)
      if (intent.type === 'headless-command') {
        switch (intent.command) {
          case 'list_profiles':
            if (options.rejectLists) throw new Error('profile catalog unavailable')
            return accepted({ profiles })
          case 'validate_profile':
            return accepted({
              ref: intent.params.ref,
              report: {
                ok: true,
                issues: [{ level: 'info', code: 'PROFILE_OK', message: 'Profile is valid' }],
              },
            })
          case 'select_profile':
            currentView = { ...currentView, profileName: 'Reviewer', revision: 8 }
            return accepted({ profile: profiles[0] })
          case 'list_connections':
            if (options.rejectLists) throw new Error('connection catalog unavailable')
            return accepted({ connections })
          case 'test_connection':
            if (intent.params.connectionId === 'connection-cloud') {
              const cloud = connections[1]
              return accepted({
                connection: {
                  ...cloud,
                  health: { status: 'unauthorized', checkedAt: at },
                  modelVerification: {
                    model: 'provider/reviewer',
                    status: 'unauthorized',
                    checkedAt: at,
                  },
                  ready: false,
                },
                health: { status: 'unauthorized', checkedAt: at },
                modelVerification: {
                  model: 'provider/reviewer',
                  status: 'unauthorized',
                  checkedAt: at,
                },
                ready: false,
              })
            }
            return accepted({
              connection: localConnection,
              health: localConnection.health,
              modelVerification: localConnection.modelVerification,
              ready: true,
            })
          case 'select_connection':
            currentView = { ...currentView, connection: 'Local Bridge', revision: 8 }
            return accepted({ connection: localConnection })
          default:
            return accepted(undefined)
        }
      }
      if (intent.type === 'run-command') return accepted(undefined)
      return accepted(undefined)
    },
    waitForIdle: async () => currentView,
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
}

test('configuration view modules stay below the production size bound', () => {
  const root = join(process.cwd(), 'src/views/tui')
  const files = readdirSync(root).filter((file) =>
    /^(?:configuration|profile-editor|connection-setup)-?.*\.ts$/u.test(file),
  )
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/u).length
    assert.ok(lines <= 300, `${file} has ${lines} lines`)
  }
})

test('initial catalog failures remain visible in their panels', async () => {
  const profiles = new ProfileEditorViewPanel(theme, {
    controller: controllerFor([], { rejectLists: true }),
  })
  const connections = new ConnectionSetupViewPanel(theme, {
    controller: controllerFor([], { rejectLists: true }),
  })
  profiles.focused = true
  connections.focused = true

  await settle()

  assert.match(
    profiles.render(80).join('\n'),
    /Profiles unavailable · refresh failed · profile catalog unavailable/u,
  )
  assert.match(
    connections.render(80).join('\n'),
    /Connections unavailable · refresh failed · connection catalog unavailable/u,
  )
})

test('first-run review keeps exact effective values and credential boundaries legible', async () => {
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'profile:reviewer',
      label: 'workspace profile',
      writable: false,
      trusted: true,
    },
    profile('Reviewer', false),
  )
  const connection = {
    id: 'connection-local',
    kind: 'cli-bridge' as const,
    name: 'Local Bridge',
    endpoint: 'https://bridge.example.test/v1',
    credentialRef: 'credential-secret-canary',
    providerOptions: { transport: 'https' as const, capabilityHints: ['stream'] },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'healthy' as const, checkedAt: at },
  }
  let applied: { profileId: string; connectionId: string } | undefined
  const wizard = new ConfigurationWizard({
    theme,
    profiles: [record],
    connections: [connection],
    onCommit: (selection) => {
      applied = { profileId: selection.profile.id, connectionId: selection.connection.id }
    },
    onComplete: () => {},
    onCancel: () => {},
    confirmation: () => ({
      runner: 'pi',
      model: 'pi/openai-codex/gpt-5.6-luna',
      effort: 'high',
      workdir: '/workspace',
      verification: 'verified: local model check',
      unsupported: ['provider workdir placement'],
    }),
  })
  wizard.focused = true

  wizard.handleInput('\r')
  wizard.handleInput('\r')
  const wide = wizard.render(80).join('\n')
  assert.match(wide, /Reviewer → Local Bridge/u)
  assert.match(wide, /runner: pi/u)
  assert.match(wide, /model: pi\/openai-codex\/gpt-5\.6-luna/u)
  assert.match(wide, /effort: high/u)
  assert.match(wide, /workdir: \/workspace/u)
  assert.match(wide, /verification: verified/u)
  assert.match(wide, /unsupported: provider workdir placement/u)
  assert.match(wide, /credentials configured outside Braid · value hidden/u)
  assert.doesNotMatch(wide, /credential-secret-canary/u)

  const narrowLines = wizard.render(40)
  assert.ok(narrowLines.every((line) => visibleWidth(line) <= 40))
  assert.match(narrowLines.join('\n'), /runner:/u)
  assert.match(narrowLines.join('\n'), /cwd:/u)
  assert.match(narrowLines.join('\n'), /cred hidden/u)

  wizard.handleInput('\r')
  await settle()
  assert.deepEqual(applied, { profileId: record.id, connectionId: connection.id })
  assert.match(wizard.render(80).join('\n'), /selection applied/u)
})

test('profile editor uses canonical summaries and validates without advertising a fake save', async () => {
  const calls: BraidIntent[] = []
  const panel = new ProfileEditorViewPanel(theme, {
    controller: controllerFor(calls),
    nextOperationId: () => 'profile-ui-test',
  })
  panel.focused = true
  await settle()
  const initial = panel.render(80).join('\n')
  assert.match(initial, /Reviewer/u)
  assert.doesNotMatch(initial, /Active profile/u)
  assert.match(initial, /pi/u)
  assert.match(initial, /provider\/reviewer/u)
  assert.doesNotMatch(initial, /secret-canary|secret-profile\.json/u)
  const narrow = panel.render(40)
  assert.ok(narrow.length <= 12)
  assert.match(narrow.join('\n'), /enter select · \^V validate · ←\/esc/u)
  assert.match(narrow.join('\n'), /close/u)
  assert.doesNotMatch(narrow.join('\n'), /save/iu)

  panel.handleInput('\u0016')
  await settle()
  const validation = calls.at(-1)
  assert.equal(validation?.type, 'headless-command')
  assert.equal(
    validation?.type === 'headless-command' ? validation.command : undefined,
    'validate_profile',
  )
  assert.match(panel.render(80).join('\n'), /Profile valid/u)
  assert.equal(
    calls.some((intent) => intent.type === 'run-command'),
    false,
  )
})

test('one profile renders a focused summary without a redundant switch list', async () => {
  const panel = new ProfileEditorViewPanel(theme, {
    controller: controllerFor([], { singleProfile: true }),
  })
  panel.focused = true
  await settle()
  const rendered = panel.render(80).join('\n')
  assert.match(rendered, /Reviewer/u)
  assert.match(rendered, /runner pi · model provider\/reviewer/u)
  assert.doesNotMatch(rendered, /switch profile|profiles/u)
  assert.match(rendered, /←\/esc close/u)
})

test('built-in starter details omit the implicit source while real sources remain visible', () => {
  const builtIn = {
    ...profileSummary('Braid starter', false),
    source: {
      kind: 'inline' as const,
      reference: 'braid:active',
      label: 'Braid starter',
      writable: false,
      trusted: true,
    },
  }
  const builtInText = profileDetailLines(builtIn).join('\n')
  assert.doesNotMatch(builtInText, /source Braid starter/u)
  assert.match(builtInText, /trusted · read-only/u)

  const sourceText = profileDetailLines(profileSummary('Reviewer', false)).join('\n')
  assert.match(sourceText, /source workspace profile/u)
})

test('profile and configuration selectors close with either back key', async () => {
  const connection = {
    id: 'connection-left-key',
    kind: 'cli-bridge' as const,
    name: 'Local Bridge',
    endpoint: 'https://bridge.example.test/v1',
    providerOptions: { transport: 'https' as const, capabilityHints: ['stream'] },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'healthy' as const, checkedAt: at },
  }
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'profile:left-key',
      label: 'Left key profile',
      writable: false,
      trusted: true,
    },
    profile('Left key profile', false),
  )

  for (const key of ['\u001b[D', '\u001b']) {
    let profileCancelled = 0
    const profiles = new ProfileEditorViewPanel(theme, {
      controller: controllerFor([]),
      onCancel: () => {
        profileCancelled += 1
      },
    })
    profiles.focused = true
    await settle()
    profiles.handleInput(key)
    assert.equal(profileCancelled, 1, `profile ${JSON.stringify(key)}`)

    let configurationCancelled = 0
    const wizard = new ConfigurationWizard({
      theme,
      profiles: [record],
      connections: [connection],
      onCommit: () => {},
      onComplete: () => {},
      onCancel: () => {
        configurationCancelled += 1
      },
    })
    wizard.focused = true
    wizard.handleInput(key)
    assert.equal(configurationCancelled, 1, `configuration ${JSON.stringify(key)}`)
  }
})

test('connection setup shows health and capabilities without endpoints or credentials, then applies exact keyboard actions', async () => {
  const calls: BraidIntent[] = []
  let cancelled = false
  const panel = new ConnectionSetupViewPanel(theme, {
    controller: controllerFor(calls),
    nextOperationId: () => 'connection-ui-test',
    onCancel: () => {
      cancelled = true
    },
  })
  panel.focused = true
  await settle()
  const initial = panel.render(80).join('\n')
  assert.match(initial, /Active connection · Local Bridge/u)
  assert.match(initial, /healthy/u)
  assert.match(initial, /credential configured/u)
  assert.doesNotMatch(initial, /access_token|secret-canary/u)
  const narrow = panel.render(40)
  assert.ok(narrow.length <= 12)
  assert.match(narrow.join('\n'), /enter select · \^T test · ←\/esc close/u)

  panel.handleInput('\u0014')
  await settle()
  const testIntent = [...calls]
    .reverse()
    .find((intent) => intent.type === 'headless-command' && intent.command === 'test_connection')
  assert.equal(testIntent?.type, 'headless-command')
  assert.equal(
    testIntent?.type === 'headless-command' ? testIntent.command : undefined,
    'test_connection',
  )
  assert.equal(
    testIntent?.type === 'headless-command' ? testIntent.params.connectionId : undefined,
    'connection-local',
  )
  assert.match(
    panel.render(80).join('\n'),
    /Tested Local Bridge · health healthy · model verified/u,
  )

  panel.handleInput('\u001b[B')
  panel.handleInput('\u0014')
  await settle()
  const cloudTestIntent = [...calls]
    .reverse()
    .find((intent) => intent.type === 'headless-command' && intent.command === 'test_connection')
  assert.equal(
    cloudTestIntent?.type === 'headless-command' ? cloudTestIntent.params.connectionId : undefined,
    'connection-cloud',
  )
  assert.match(
    panel.render(80).join('\n'),
    /Tested Cloud Bridge · health unauthorized · model unauthorized/u,
  )
  assert.match(panel.render(80).join('\n'), /unauthorized/u)

  panel.handleInput('\u001b[A')
  panel.handleInput('\r')
  await settle()
  const selectIntent = [...calls]
    .reverse()
    .find((intent) => intent.type === 'headless-command' && intent.command === 'select_connection')
  assert.equal(selectIntent?.type, 'headless-command')
  assert.equal(
    selectIntent?.type === 'headless-command' ? selectIntent.command : undefined,
    'select_connection',
  )
  assert.deepEqual(selectIntent?.type === 'headless-command' ? selectIntent.params : undefined, {
    connectionId: 'connection-local',
    expectedRevision: 7,
  })

  panel.handleInput('\u001b')
  assert.equal(cancelled, true)
})

test('profile selection uses the exact id when display names collide', async () => {
  const calls: BraidIntent[] = []
  const panel = new ProfileEditorViewPanel(theme, {
    controller: controllerFor(calls, { duplicateProfileName: true }),
    nextOperationId: () => 'profile-duplicate-test',
  })
  panel.focused = true
  await settle()

  panel.handleInput('\r')
  await settle()
  const selected = [...calls]
    .reverse()
    .find((intent) => intent.type === 'headless-command' && intent.command === 'select_profile')
  assert.equal(selected?.type, 'headless-command')
  assert.equal(
    selected?.type === 'headless-command' ? selected.params.ref : undefined,
    'profile-reviewer',
  )
  assert.doesNotMatch(calls.map((intent) => intent.type).join(','), /run-command/u)
})

test('static profile and connection views mask secret-designated fields and keep narrow rows bounded', () => {
  const profilePanel = new ProfileEditorViewPanel(theme)
  profilePanel.setView({
    profileEditor: {
      source: 'workspace profile',
      digest: 'sha256:profile',
      readOnly: true,
      validation: 'valid',
      fields: [
        { path: 'model.default', value: 'provider/reviewer', secret: false },
        { path: 'credentials.apiKey', value: 'secret-canary', secret: true },
      ],
    },
  } as unknown as BraidViewModel)
  const connectionPanel = new ConnectionSetupViewPanel(theme)
  connectionPanel.setView({
    connectionSetup: {
      kind: 'cli-bridge',
      fields: [
        {
          label: 'endpoint',
          value: 'https://bridge.example.test/v1?access_token=secret-canary',
          secret: false,
        },
        { label: 'token', value: 'secret-canary', secret: false },
      ],
      health: 'healthy',
      capabilities: ['stream'],
    },
  } as unknown as BraidViewModel)
  for (const panel of [profilePanel, connectionPanel]) {
    const lines = panel.render(40)
    assert.ok(lines.every((line) => visibleWidth(line) <= 40))
    assert.doesNotMatch(lines.join('\n'), /secret-canary/u)
  }
  const connectionText = connectionPanel.render(80).join('\n')
  assert.match(connectionText, /https:\/\/bridge\.example\.test\/v1/u)
  assert.doesNotMatch(connectionText, /access_token|secret-canary/u)
})
