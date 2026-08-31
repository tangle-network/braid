import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { createProfileRecord } from '../src/app/profiles.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import { ConfigurationWizard } from '../src/views/tui/configuration-wizard.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const at = '2026-08-03T20:00:00.000Z'
const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })

function makeProfile(): AgentProfile {
  return {
    name: 'reviewer',
    prompt: { systemPrompt: 'Review carefully.' },
    model: { default: 'openai/gpt-5.6', reasoningEffort: 'high' },
    harness: 'pi',
  }
}

function makeNamedProfile(name: string): AgentProfile {
  return {
    ...makeProfile(),
    name,
    prompt: { systemPrompt: `Review as ${name}.` },
    model: { default: `model/${name}`, reasoningEffort: 'high' },
  }
}

function makeConnection(): ConnectionRecord {
  return {
    id: createConnectionId('connection-local-cli'),
    kind: 'cli-bridge',
    name: 'Local CLI Bridge',
    endpoint: 'http://127.0.0.1:3344/v1',
    credentialRef: 'credential-secret-ref',
    providerOptions: { transport: 'local', capabilityHints: ['stream', 'usage'] },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'healthy', checkedAt: at },
  }
}

function makeConnectionVariant(kind: ConnectionRecord['kind'], name: string): ConnectionRecord {
  return {
    ...makeConnection(),
    id: createConnectionId(`connection-${name}`),
    kind,
    name,
    providerOptions: {
      transport: kind === 'cli-bridge' ? 'local' : 'https',
      capabilityHints: ['stream', 'usage'],
    },
  }
}

test('configuration wizard renders the two choices and never renders credential material', async () => {
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'test:reviewer',
      label: 'workspace profile',
      writable: false,
      trusted: true,
    },
    makeProfile(),
  )
  const connection = makeConnection()
  let selected: { profileId: string; connectionId: string } | undefined
  const wizard = new ConfigurationWizard({
    theme,
    profiles: [record],
    connections: [connection],
    onCommit: (selection) => {
      selected = { profileId: selection.profile.id, connectionId: selection.connection.id }
    },
    onComplete: () => {},
    onCancel: () => {},
    confirmation: () => ({
      runner: 'pi',
      model: 'pi/openai-codex/gpt-5.6-luna',
      effort: 'high',
      workdir: '/workspace',
      verification: 'unverified: discovery only',
      unsupported: ['provider workdir placement'],
    }),
  })
  wizard.focused = true

  assert.match(wizard.render(80).join('\n'), /choose an AgentProfile/u)
  assert.match(wizard.render(80).join('\n'), /reviewer/u)
  assert.doesNotMatch(wizard.render(80).join('\n'), /credential-secret-ref/u)

  wizard.handleInput('\r')
  assert.match(wizard.render(80).join('\n'), /choose a connection/u)
  assert.match(wizard.render(80).join('\n'), /Local CLI Bridge/u)
  wizard.handleInput('\r')
  assert.match(wizard.render(80).join('\n'), /review and start/u)
  const confirmation = wizard.render(80).join('\n')
  assert.match(confirmation, /runner: pi/u)
  assert.match(confirmation, /model: pi\/openai-codex\/gpt-5\.6-luna/u)
  assert.match(confirmation, /effort: high/u)
  assert.match(confirmation, /workdir: \/workspace/u)
  assert.match(confirmation, /verification: unverified/u)
  assert.match(confirmation, /unsupported: provider workdir placement/u)
  wizard.handleInput('\r')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(selected, { profileId: record.id, connectionId: connection.id })
  assert.match(wizard.render(80).join('\n'), /selection applied/u)
})

test('configuration wizard reports success only after an asynchronous commit finishes', async () => {
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'test:pending-reviewer',
      label: 'workspace profile',
      writable: false,
      trusted: true,
    },
    makeProfile(),
  )
  let finishCommit: (() => void) | undefined
  const pendingCommit = new Promise<void>((resolve) => {
    finishCommit = resolve
  })
  const wizard = new ConfigurationWizard({
    theme,
    profiles: [record],
    connections: [makeConnection()],
    onCommit: () => pendingCommit,
    onComplete: () => {},
    onCancel: () => {},
  })
  wizard.focused = true
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  const applying = wizard.render(80).join('\n')
  assert.match(applying, /applying selection/u)
  assert.doesNotMatch(applying, /selection applied/u)

  finishCommit?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(wizard.render(80).join('\n'), /selection applied/u)
})

test('the terminal extension opens first-run setup and returns focus after cancel', async () => {
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'test:reviewer',
      label: 'workspace profile',
      writable: false,
      trusted: true,
    },
    makeProfile(),
  )
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme,
    workspace: '/workspace',
    nextOperationId: () => 'op-configuration-test',
    configuration: {
      profiles: [record],
      connections: [makeConnection()],
      openOnStart: true,
      onCommit: () => {},
    },
  })
  const done = view.start()
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /braid setup/u)
  terminal.sendInput('\u001b')
  await terminal.waitForRender()
  assert.doesNotMatch(terminal.getViewport().join('\n'), /choose an AgentProfile/u)
  assert.equal(view.editor.focused, true)
  view.stop()
  await done
  await app.close()
})

test('a failed apply stays recoverable and Escape cancels the staged selection', async () => {
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'test:reviewer',
      label: 'workspace profile',
      writable: false,
      trusted: true,
    },
    makeProfile(),
  )
  let cancelled = false
  const wizard = new ConfigurationWizard({
    theme,
    profiles: [record],
    connections: [makeConnection()],
    onCommit: () => {
      throw new Error(
        'CLI Bridge advertised pi/openai-codex/gpt-5.6-luna but returned 501 not_configured. Configure the selected bridge backend and its local subscription credentials, then retry setup.',
      )
    },
    onComplete: () => {},
    onCancel: () => {
      cancelled = true
    },
  })
  wizard.focused = true
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(
    wizard.render(80).join('\n'),
    /501\s+not_configured[\s\S]*Configure[\s\S]*credentials/iu,
  )
  wizard.handleInput('\u001b')
  assert.equal(cancelled, true)
})

test('an empty catalog explains the dead end and only Escape closes setup', () => {
  let cancelled = false
  const wizard = new ConfigurationWizard({
    theme,
    profiles: [],
    connections: [],
    onCommit: () => {},
    onComplete: () => {},
    onCancel: () => {
      cancelled = true
    },
  })
  wizard.focused = true
  wizard.handleInput('\r')
  assert.match(wizard.render(80).join('\n'), /No AgentProfiles are available/u)
  assert.equal(cancelled, false)
  wizard.handleInput('\u001b')
  assert.equal(cancelled, true)
})

test('mounted first-run setup preserves choices and fits keyboard guidance at narrow and wide sizes', async () => {
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
  ] as const) {
    const terminal = new VirtualTerminal(columns, rows)
    const tui = new TuiMainScreen(terminal)
    const app = createBraidApplication({ fixture: 'deterministic' })
    app.initialize('/workspace')
    const view = new BraidTerminalApp({
      controller: createApplicationUiController(app),
      tui,
      theme,
      workspace: '/workspace',
      nextOperationId: () => `op-configuration-${columns}`,
      configuration: {
        profiles: [
          createProfileRecord(
            {
              kind: 'inline',
              reference: 'test:reviewer',
              label: 'workspace profile',
              writable: false,
              trusted: true,
            },
            makeNamedProfile('reviewer'),
          ),
          createProfileRecord(
            {
              kind: 'inline',
              reference: 'test:coder',
              label: 'workspace profile',
              writable: false,
              trusted: true,
            },
            makeNamedProfile('coder'),
          ),
        ],
        connections: [
          makeConnectionVariant('tangle-sandbox', 'remote-sandbox'),
          makeConnectionVariant('cli-bridge', 'local-cli'),
          makeConnectionVariant('tangle-inference', 'cloud-inference'),
        ],
        openOnStart: true,
        onCommit: () => {},
      },
    })
    const done = view.start()
    try {
      await terminal.waitForRender()
      const frame = (label: string): string => {
        const lines = terminal.getViewport()
        assert.ok(
          lines.every((line) => line.length <= columns),
          `${label} contains a line wider than ${columns} columns`,
        )
        return lines.join('\n')
      }

      assert.match(frame('profile'), /choose an AgentProfile/u)
      assert.match(frame('profile'), /filter · enter choose · ←\/esc cancel/u)
      terminal.sendInput('\u001b[B')
      terminal.sendInput('\r')
      await terminal.waitForRender()
      assert.match(frame('connection'), /choose a connection/u)

      terminal.sendInput('\u001b[B')
      terminal.sendInput('\u001b[B')
      terminal.sendInput('\r')
      await terminal.waitForRender()
      terminal.sendInput('\r')
      terminal.sendInput('\r')
      terminal.sendInput('\r')
      await terminal.waitForRender()
      assert.match(frame('confirm'), /reviewer → remote-sandbox/u)
      assert.doesNotMatch(frame('confirm'), /credential-secret-ref/u)

      terminal.sendInput('\u001b[B')
      terminal.sendInput('\u001b[B')
      terminal.sendInput('\u001b[B')
      await terminal.waitForRender()
      assert.match(frame('confirm action'), /→ ← change AgentProfile/u)
      terminal.sendInput('\r')
      await terminal.waitForRender()
      assert.match(frame('back to profile'), /→ reviewer/u)
      assert.doesNotMatch(frame('back to profile'), /→ coder/u)

      terminal.sendInput('\u001b')
      await terminal.waitForRender()
      assert.equal(view.editor.focused, true)
    } finally {
      view.stop()
      await done
      await app.close()
    }
  }
})

test('mounted setup exposes apply errors with retry and cancel controls', async () => {
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'test:reviewer',
      label: 'workspace profile',
      writable: false,
      trusted: true,
    },
    makeProfile(),
  )
  const terminal = new VirtualTerminal(40, 12)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme,
    workspace: '/workspace',
    nextOperationId: () => 'op-configuration-error',
    configuration: {
      profiles: [record],
      connections: [makeConnection()],
      openOnStart: true,
      onCommit: () => {
        throw new Error('connection refused')
      },
    },
  })
  const done = view.start()
  try {
    await terminal.waitForRender()
    terminal.sendInput('\r')
    terminal.sendInput('\r')
    terminal.sendInput('\r')
    await terminal.waitForRender()
    const frame = terminal.getViewport().join('\n')
    assert.match(frame, /connection refused/u)
    assert.match(frame, /Apply and start/u)
    assert.match(frame, /Cancel/u)
    assert.doesNotMatch(frame, /Applying/u)
    terminal.sendInput('\u001b')
    await terminal.waitForRender()
    assert.equal(view.editor.focused, true)
  } finally {
    view.stop()
    await done
    await app.close()
  }
})

test('cloud workspace setup accepts edits, reports invalid refs, and preserves back navigation', () => {
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'test:workspace-form',
      label: 'workspace profile',
      writable: false,
      trusted: true,
    },
    makeProfile(),
  )
  const cloud = makeConnectionVariant('tangle-sandbox', 'workspace-form-cloud')
  const wizard = new ConfigurationWizard({
    theme,
    profiles: [record],
    connections: [cloud],
    onCommit: () => {},
    onComplete: () => {},
    onCancel: () => {},
  })
  wizard.focused = true
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  const initial = wizard.render(40)
  assert.match(initial.join('\n'), /workspace · cloud sandbox/u)
  assert.match(initial.join('\n'), /blank = repository root/u)
  assert.match(initial.join('\n'), /start in \(repo-relative\)/u)
  assert.match(initial.join('\n'), /tab\/enter continues/u)
  assert.doesNotMatch(initial.join('\n'), /braid setup/u)
  assert.ok(initial.every((line) => visibleWidth(line) <= 40))

  // Submit an invalid ref first. The form keeps the field values and points back to git ref.
  wizard.handleInput('\r')
  wizard.handleInput('main')
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  const invalidFrame = wizard.render(40)
  assert.match(invalidFrame.join('\n'), /gitRef requires repoUrl/u)
  assert.ok(invalidFrame.every((line) => visibleWidth(line) <= 40))

  // Shift-tab returns to the repository field, then the valid request reaches review.
  wizard.handleInput('\u001b[Z')
  wizard.handleInput('https://github.com/tangle-network/braid')
  wizard.handleInput('\t')
  wizard.handleInput('\t')
  wizard.handleInput('src')
  wizard.handleInput('\r')
  const review = wizard.render(80).join('\n')
  assert.match(review, /cloud workspace/u)
  assert.match(review, /github\.com\/tangle-network\/braid/u)
  assert.match(review, /ref main/u)
  assert.match(review, /start in repo src/u)

  // The review action returns to the form with edits intact.
  wizard.handleInput('\u001b[B')
  wizard.handleInput('\r')
  const restored = wizard.render(80).join('\n')
  assert.match(restored, /github\.com\/tangle-network\/braid/u)
  assert.match(restored, /main/u)
  wizard.handleInput('\u001b[Z')
  assert.match(wizard.render(80).join('\n'), /choose a connection/u)
  wizard.handleInput('\r')
  assert.match(wizard.render(80).join('\n'), /github\.com\/tangle-network\/braid/u)
  wizard.handleInput('\u001b')
  assert.match(wizard.render(80).join('\n'), /choose a connection/u)
})

test('blank Sandbox cwd is submitted as the repository root', () => {
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'test:workspace-root-form',
      label: 'workspace root profile',
      writable: false,
      trusted: true,
    },
    makeProfile(),
  )
  const cloud = makeConnectionVariant('tangle-sandbox', 'workspace-root-cloud')
  let submitted: unknown
  const wizard = new ConfigurationWizard({
    theme,
    profiles: [record],
    connections: [cloud],
    onCommit: (selection) => {
      submitted = selection.workspaceRequest
    },
    onComplete: () => {},
    onCancel: () => {},
  })
  wizard.focused = true
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  wizard.handleInput('https://github.com/tangle-network/braid')
  wizard.handleInput('\t')
  wizard.handleInput('main')
  wizard.handleInput('\t')
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  assert.deepEqual(submitted, {
    repoUrl: 'https://github.com/tangle-network/braid',
    gitRef: 'main',
    cwd: '.',
  })
})

test('mounted setup redraws when a long asynchronous apply finishes', async () => {
  const record = createProfileRecord(
    {
      kind: 'inline',
      reference: 'test:async-reviewer',
      label: 'workspace profile',
      writable: false,
      trusted: true,
    },
    makeProfile(),
  )
  let finishCommit: (() => void) | undefined
  const pendingCommit = new Promise<void>((resolve) => {
    finishCommit = resolve
  })
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme,
    workspace: '/workspace',
    nextOperationId: () => 'op-configuration-async',
    configuration: {
      profiles: [record],
      connections: [makeConnection()],
      openOnStart: true,
      onCommit: () => pendingCommit,
    },
  })
  const done = view.start()
  try {
    await terminal.waitForRender()
    terminal.sendInput('\r')
    await terminal.waitForRender()
    terminal.sendInput('\r')
    await terminal.waitForRender()
    terminal.sendInput('\r')
    await terminal.waitForRender()
    assert.match(terminal.getViewport().join('\n'), /Applying/u)

    finishCommit?.()
    await terminal.waitForRender()
    assert.match(terminal.getViewport().join('\n'), /selection applied/u)
  } finally {
    view.stop()
    await done
    await app.close()
  }
})
