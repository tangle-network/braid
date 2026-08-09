import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import type { ConnectionUpsertResult } from '../src/app/connection-action-types.js'
import { createBraidApplication } from '../src/app/composition.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import type {
  ConnectionCreationInput,
  ConnectionLifecyclePort,
  ConnectionRemovalPreview,
} from '../src/ports/connection-lifecycle.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const connection: ConnectionRecord = {
  id: 'connection-removable',
  kind: 'cli-bridge',
  name: 'Removable bridge',
  endpoint: 'http://127.0.0.1:3344',
  providerOptions: { transport: 'local' },
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  lastHealth: { status: 'unknown' },
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for connection workflow')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

class RecordingLifecycle implements ConnectionLifecyclePort {
  readonly creations: Array<{
    readonly input: Omit<ConnectionCreationInput, 'credential'>
    readonly credential?: string
  }> = []
  readonly removals: string[] = []
  preview: ConnectionRemovalPreview = {
    connectionId: connection.id,
    name: connection.name,
    blockers: [],
    credential: 'unique',
    sharedCredentialConnectionIds: [],
  }

  requiresCredential(draft: ConnectionCreationInput['draft']): boolean {
    return draft.kind !== 'cli-bridge'
  }

  create(input: ConnectionCreationInput): Promise<ConnectionUpsertResult> {
    const { credential, ...metadata } = input
    this.creations.push({
      input: metadata,
      ...(credential === undefined
        ? {}
        : { credential: new TextDecoder().decode(Uint8Array.from(credential)) }),
    })
    return Promise.resolve({
      connection: {
        id: `connection-${input.draft.kind}`,
        name: input.draft.name,
        kind: input.draft.kind,
        endpoint: input.draft.endpoint,
        credentialConfigured: credential !== undefined,
        health: { status: 'unknown' },
        capabilityHints: [],
        ready: false,
      },
      revision: input.expectedRevision ?? 0,
      replayed: false,
    })
  }

  previewRemoval(): ConnectionRemovalPreview {
    return this.preview
  }

  remove(input: { readonly connectionId: string }): Promise<{
    readonly connection: ConnectionUpsertResult['connection']
    readonly removed: true
    readonly revision: number
    readonly replayed: boolean
  }> {
    this.removals.push(input.connectionId)
    return Promise.resolve({
      connection: {
        id: connection.id,
        name: connection.name,
        kind: connection.kind,
        ...(connection.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
        credentialConfigured: true,
        health: connection.lastHealth,
        capabilityHints: [],
        ready: false,
      },
      removed: true,
      revision: 1,
      replayed: false,
    })
  }
}

function terminalProduct(lifecycle: RecordingLifecycle): {
  readonly terminal: VirtualTerminal
  readonly view: BraidTerminalApp
  readonly done: Promise<void>
} {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app, {}, undefined, { connections: [connection] }),
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `operation-connection-ui-${++operation}`,
    connectionLifecycle: lifecycle,
  })
  return { terminal, view, done: view.start() }
}

test('keyboard create uses metadata-only fields and a masked Tangle credential', async () => {
  const lifecycle = new RecordingLifecycle()
  const { terminal, view, done } = terminalProduct(lifecycle)
  try {
    terminal.sendInput('/connection create')
    terminal.sendInput('\r')
    await waitUntil(() => terminal.getViewport().join('\n').includes('connection metadata'))
    terminal.sendInput('\u001b[B')
    terminal.sendInput('\r')
    for (let field = 0; field < 4; field += 1) terminal.sendInput('\r')
    await waitUntil(() => terminal.getViewport().join('\n').includes('review connection'))
    terminal.sendInput('\r')
    await waitUntil(() =>
      terminal.getViewport().join('\n').includes('credential · Tangle Inference'),
    )
    terminal.sendInput('secret-canary-value')
    assert.doesNotMatch(terminal.getViewport().join('\n'), /secret-canary-value/u)
    terminal.sendInput('\r')
    await waitUntil(() => lifecycle.creations.length === 1)
    assert.equal(lifecycle.creations[0]?.input.draft.kind, 'tangle-inference')
    assert.equal(lifecycle.creations[0]?.credential, 'secret-canary-value')
    assert.doesNotMatch(terminal.getScrollBuffer().join('\n'), /secret-canary-value/u)
  } finally {
    view.stop()
    await done
  }
})

test('keyboard removal explains credential cleanup and requires confirmation', async () => {
  const lifecycle = new RecordingLifecycle()
  const { terminal, view, done } = terminalProduct(lifecycle)
  try {
    terminal.sendInput('/connection')
    terminal.sendInput('\r')
    await waitUntil(() => terminal.getViewport().join('\n').includes('Removable bridge'))
    terminal.sendInput('\u0004')
    await terminal.waitForRender()
    assert.match(terminal.getViewport().join('\n'), /remove connection/u)
    const confirmation = terminal.getViewport().join('\n')
    assert.match(confirmation, /unshared secure credential\s+will be deleted/u)
    assert.match(confirmation, /cloud\s+resources are never destroyed/u)
    terminal.sendInput('\r')
    await waitUntil(() => lifecycle.removals.length === 1)
    assert.deepEqual(lifecycle.removals, [connection.id])
  } finally {
    view.stop()
    await done
  }
})
