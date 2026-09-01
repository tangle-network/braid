import assert from 'node:assert/strict'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { createProfileRecord } from '../src/app/profiles.js'
import type { ConnectionKind, ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import { ConfigurationWizard } from '../src/views/tui/configuration-wizard.js'
import { createBraidTheme } from '../src/views/tui/theme.js'

const at = '2026-08-09T00:00:00.000Z'
const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })
const profile = createProfileRecord(
  {
    kind: 'inline',
    reference: 'test:credential-flow',
    label: 'workspace profile',
    writable: false,
    trusted: true,
  },
  defineAgentProfile({
    name: 'Credential flow',
    harness: 'pi',
    model: { default: 'tangle-router/glm-5.2', reasoningEffort: 'high' },
  }),
)

function connection(kind: ConnectionKind): ConnectionRecord {
  const suffix = kind.replaceAll('-', '_')
  return {
    id: createConnectionId(`connection-${suffix}`),
    kind,
    name:
      kind === 'cli-bridge'
        ? 'Local CLI Bridge'
        : kind === 'tangle-inference'
          ? 'Tangle Inference'
          : 'Tangle Sandbox',
    endpoint:
      kind === 'cli-bridge'
        ? 'http://127.0.0.1:3344'
        : kind === 'tangle-inference'
          ? 'https://router.tangle.tools'
          : 'https://sandbox.tangle.tools',
    providerOptions: { transport: kind === 'cli-bridge' ? 'local' : 'https' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}

test('first-run Tangle selection masks, transfers, and clears credential bytes', async () => {
  const copied: number[][] = []
  let callbackBuffer: Uint8Array | undefined
  const wizard = new ConfigurationWizard({
    theme,
    profiles: [profile],
    connections: [
      connection('cli-bridge'),
      connection('tangle-inference'),
      connection('tangle-sandbox'),
    ],
    requiresCredential: (record) => record.kind !== 'cli-bridge',
    onCommit: (_selection, credential) => {
      assert.ok(credential)
      callbackBuffer = credential
      copied.push([...credential])
    },
    onComplete: () => {},
    onCancel: () => {},
  })
  wizard.focused = true

  wizard.handleInput('\r')
  wizard.handleInput('\u001b[B')
  wizard.handleInput('\r')
  assert.match(wizard.render(80).join('\n'), /credential · Tangle Inference/u)

  wizard.handleInput('terminal-secret-canary')
  assert.doesNotMatch(wizard.render(80).join('\n'), /terminal-secret-canary/u)
  wizard.handleInput('\r')
  const review = wizard.render(80).join('\n')
  assert.match(review, /ready for secure storage · value hidden/u)
  assert.doesNotMatch(review, /terminal-secret-canary/u)

  wizard.handleInput('\r')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(copied, [[...new TextEncoder().encode('terminal-secret-canary')]])
  assert.ok(callbackBuffer)
  assert.equal(
    callbackBuffer?.every((byte) => byte === 0),
    true,
  )
  assert.doesNotMatch(wizard.render(80).join('\n'), /terminal-secret-canary/u)
})

test('Escape from credential input returns to connection choice without committing', () => {
  let commits = 0
  const wizard = new ConfigurationWizard({
    theme,
    profiles: [profile],
    connections: [connection('tangle-sandbox')],
    requiresCredential: () => true,
    onCommit: () => {
      commits += 1
    },
    onComplete: () => {},
    onCancel: () => {},
  })
  wizard.focused = true
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  wizard.handleInput('\r')
  wizard.handleInput('discarded-secret')
  wizard.handleInput('\u001b')
  assert.match(wizard.render(80).join('\n'), /choose a connection/u)
  assert.doesNotMatch(wizard.render(80).join('\n'), /discarded-secret/u)
  assert.equal(commits, 0)
})
