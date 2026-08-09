import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { ConnectionMetadataEditor } from '../src/views/tui/connection-metadata-editor.js'
import { validateConnectionMetadataDraft } from '../src/views/tui/connection-metadata-editor-model.js'
import { connectionMetadataFormDefaults } from '../src/views/tui/connection-metadata-editor-presentation.js'
import { createBraidTheme } from '../src/views/tui/theme.js'

const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })

test('connection metadata defaults are provider-neutral and omit irrelevant fields', () => {
  const cli = connectionMetadataFormDefaults('cli-bridge')
  const inference = connectionMetadataFormDefaults('tangle-inference')
  const sandbox = connectionMetadataFormDefaults('tangle-sandbox')

  assert.equal(cli.endpoint, 'http://127.0.0.1:3344')
  assert.equal(inference.endpoint, 'https://router.tangle.tools')
  assert.equal(sandbox.endpoint, 'https://sandbox.tangle.tools')
  const result = validateConnectionMetadataDraft(cli)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.draft, {
      kind: 'cli-bridge',
      name: 'Local CLI Bridge',
      endpoint: 'http://127.0.0.1:3344',
    })
  }
})

test('validation accepts safe HTTPS and loopback HTTP, with Tangle-only account and region', () => {
  const result = validateConnectionMetadataDraft({
    kind: 'tangle-inference',
    name: 'team router',
    endpoint: 'https://router.example.test/api',
    account: 'team-a',
    region: 'us-west',
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.draft, {
      kind: 'tangle-inference',
      name: 'team router',
      endpoint: 'https://router.example.test/api',
      account: 'team-a',
      region: 'us-west',
    })
  }

  const irrelevant = validateConnectionMetadataDraft({
    kind: 'cli-bridge',
    name: 'local',
    endpoint: 'http://127.0.0.1:3344',
    region: 'us-west',
  })
  assert.equal(irrelevant.ok, false)
})

test('validation rejects credentials, query, fragments, non-HTTP(S), and remote HTTP by default', () => {
  const base = { kind: 'cli-bridge' as const, name: 'bridge' }
  const cases = [
    'https://user:password@example.test',
    'https://example.test/api?mode=fast',
    'https://example.test/api#section',
    'file:///tmp/bridge',
    'http://example.test',
  ]
  for (const endpoint of cases) {
    const result = validateConnectionMetadataDraft({ ...base, endpoint })
    assert.equal(result.ok, false, endpoint)
  }

  const credentialKey = validateConnectionMetadataDraft({
    ...base,
    endpoint: 'http://127.0.0.1:3344',
    token: 'credential-canary',
  })
  assert.equal(credentialKey.ok, false)
  assert.match(JSON.stringify(credentialKey), /Credential values are not accepted/u)
  assert.doesNotMatch(JSON.stringify(credentialKey), /credential-canary/u)

  const permitted = validateConnectionMetadataDraft(
    { ...base, endpoint: 'http://bridge.example.test' },
    { trustedTransportPolicy: ({ endpoint }) => endpoint === 'http://bridge.example.test' },
  )
  assert.equal(permitted.ok, true)
})

test('editor walks kind, fields, review, apply, back, and cancel with keyboard input', async () => {
  let applied: unknown
  let cancelled = 0
  const editor = new ConnectionMetadataEditor({
    theme,
    onApply: (draft) => {
      applied = draft
    },
    onCancel: () => {
      cancelled += 1
    },
  })
  editor.focused = true

  assert.match(editor.render(80).join('\n'), /connection kind/u)
  editor.handleInput('\r')
  assert.match(editor.render(80).join('\n'), /display name/u)
  assert.doesNotMatch(editor.render(80).join('\n'), /account \/ team/u)
  editor.handleInput('\u001b[F')
  editor.handleInput('\u0015')
  editor.handleInput('Bridge for tests')
  editor.handleInput('\r')
  editor.handleInput('\r')
  assert.match(editor.render(80).join('\n'), /review connection/u)
  editor.handleInput('\r')
  assert.deepEqual(applied, {
    kind: 'cli-bridge',
    name: 'Bridge for tests',
    endpoint: 'http://127.0.0.1:3344',
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(editor.render(80).join('\n'), /connection saved/u)

  const backEditor = new ConnectionMetadataEditor({
    theme,
    onApply: () => {},
    onCancel: () => {
      cancelled += 1
    },
  })
  backEditor.focused = true
  backEditor.handleInput('\r')
  backEditor.handleInput('\u001b[Z')
  assert.match(backEditor.render(80).join('\n'), /connection kind/u)
  backEditor.handleInput('\u001b')
  assert.equal(cancelled, 1)
})

test('editor shows Tangle-only fields and stays within all reference widths', () => {
  for (const width of [40, 80, 120, 200]) {
    const editor = new ConnectionMetadataEditor({ theme, onApply: () => {}, onCancel: () => {} })
    editor.focused = true
    editor.handleInput('\u001b[B')
    editor.handleInput('\r')
    const fields = editor.render(width)
    assert.match(fields.join('\n'), /account \/ team/u)
    assert.match(fields.join('\n'), /region \(optional\)/u)
    for (const line of fields) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`)
  }
})
