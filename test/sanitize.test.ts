import assert from 'node:assert/strict'
import test from 'node:test'
import { getCapabilities, setCapabilities } from '@earendil-works/pi-tui'
import {
  redactBraidEvent,
  redactStructuredValueWithNumericTelemetry,
} from '../src/domain/redaction.js'
import {
  sanitizeClipboardText,
  sanitizeDiff,
  sanitizeImageAlt,
  sanitizeMarkdown,
  sanitizeNotification,
  sanitizeTerminalText,
  sanitizeTitle,
  sanitizeUrl,
} from '../src/views/shared/sanitize.js'
import { SafeMarkdown } from '../src/views/tui/safe-markdown.js'
import { createBraidTheme } from '../src/views/tui/theme.js'

test('terminal sanitizer removes CSI, OSC, carriage return, C1, and bidi controls', () => {
  const bidiControls = [
    '\u061c',
    '\u200e',
    '\u200f',
    '\u202a',
    '\u202b',
    '\u202c',
    '\u202d',
    '\u202e',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
  ].join('')
  const malicious = `safe\u001b[31mred\u001b[0m\u001b]0;owned\u0007\roverwrite\u009b31m${bidiControls}evil`
  const sanitized = sanitizeTerminalText(malicious)

  assert.equal(sanitized, 'saferedoverwriteevil')
  assert.equal(sanitized.includes('\u001b'), false)
  assert.equal(sanitized.includes('\r'), false)
})

test('terminal sanitizer preserves printable Unicode, tabs, and newlines', () => {
  const text = 'ASCII\t漢字 e\u0301 👩🏽‍💻\nمرحبا'
  assert.equal(sanitizeTerminalText(text), text)
})

test('numeric token telemetry survives redaction while string tokens never do', () => {
  const redacted = redactStructuredValueWithNumericTelemetry({
    inputTokens: 12,
    output_tokens: 8,
    model: { maxTokens: 4096 },
    accessToken: 'secret-canary',
    poisoned: { inputTokens: 'secret-canary' },
    credentialConfigured: true,
  }) as Record<string, unknown>
  assert.equal(redacted.inputTokens, 12)
  assert.equal(redacted.output_tokens, 8)
  assert.deepEqual(redacted.model, { maxTokens: 4096 })
  assert.equal(redacted.accessToken, '[redacted]')
  assert.deepEqual(redacted.poisoned, { inputTokens: '[redacted]' })
  assert.equal(redacted.credentialConfigured, true)
})

test('durable credential reference identifiers survive redaction without admitting values', () => {
  const valid = redactBraidEvent({
    kind: 'connection.upserted',
    connection: {
      credentialRef: 'credential-durable-reference',
      credential: 'secret-canary',
    },
  })
  assert.equal(valid.connection.credentialRef, 'credential-durable-reference')
  assert.equal(valid.connection.credential, '[redacted]')

  const invalid = redactBraidEvent({ credentialRef: 'secret-canary' })
  assert.equal(invalid.credentialRef, '[redacted]')
})

test('conversation import events retain bounded histories beyond 256 records', () => {
  const messages = Array.from({ length: 300 }, (_, index) => ({
    id: `message-${index}`,
    inputTokens: index,
  }))
  const redacted = redactBraidEvent({ kind: 'conversation.imported', messages })
  assert.equal(redacted.messages.length, 300)
  assert.equal(redacted.messages[299]?.inputTokens, 299)
})

test('every untrusted output surface strips terminal strings before rendering', () => {
  const hostile = 'line\u001b]0;owned\u0007\nnext\u202e.txt'
  for (const sanitizer of [
    sanitizeMarkdown,
    sanitizeDiff,
    sanitizeClipboardText,
    sanitizeImageAlt,
  ]) {
    const result = sanitizer(hostile)
    assert.equal(result.includes('\u001b'), false)
    assert.equal(result.includes('\u202e'), false)
  }
  assert.equal(sanitizeTitle(hostile), 'line next.txt')
  assert.equal(sanitizeNotification(hostile), 'line next.txt')
})

test('links fail closed for non-web schemes and embedded credentials', () => {
  assert.equal(sanitizeUrl('https://example.com/path'), 'https://example.com/path')
  assert.equal(sanitizeUrl('file:///etc/passwd'), undefined)
  assert.equal(sanitizeUrl('javascript:alert(1)'), undefined)
  assert.equal(sanitizeUrl('https://user:password@example.com'), undefined)
  assert.equal(sanitizeUrl('https://example.com/?token=CANARY'), undefined)
  assert.equal(sanitizeUrl('https://example.com/#access_token=CANARY'), undefined)
})

test('markdown hides unsafe destinations and secret-bearing URLs in both terminal modes', () => {
  const previous = getCapabilities()
  const theme = createBraidTheme({
    color: 'truecolor',
    environment: { COLORTERM: 'truecolor' },
  })
  const markdown = sanitizeMarkdown(
    '[safe](https://example.com/docs) [secret](https://user:CANARY@example.com/?token=CANARY) [script](javascript:alert(1)) [file](file:///etc/passwd) `https://example.com/?api_key=CANARY`',
  )
  try {
    for (const hyperlinks of [false, true]) {
      setCapabilities({ images: null, trueColor: false, hyperlinks })
      const rendered = new SafeMarkdown(markdown, 0, 0, theme.markdown, undefined, undefined, {
        allowHyperlinks: theme.terminalMetadata,
      })
        .render(240)
        .join('\n')
      assert.equal(rendered.includes('CANARY'), false)
      assert.equal(rendered.includes('javascript:'), false)
      assert.equal(rendered.includes('file:///'), false)
      assert.match(rendered, /safe/u)
      if (hyperlinks) assert.equal(rendered.includes('\u001b]8;;https://example.com/docs'), true)
    }
  } finally {
    setCapabilities(previous)
  }
})

test('no-color and reduced-motion markdown replaces hyperlink OSC with visible URLs', () => {
  const previous = getCapabilities()
  const theme = createBraidTheme({ colors: false, reducedMotion: true })
  try {
    setCapabilities({ images: null, trueColor: false, hyperlinks: true })
    const rendered = new SafeMarkdown(
      sanitizeMarkdown('[safe](https://example.com/docs)'),
      0,
      0,
      theme.markdown,
      undefined,
      undefined,
      { allowHyperlinks: theme.terminalMetadata },
    )
      .render(240)
      .join('\n')
    assert.equal(rendered.includes('\u001b]'), false)
    assert.match(rendered, /safe/u)
    assert.match(rendered, /https:\/\/example\.com\/docs/u)
  } finally {
    setCapabilities(previous)
  }
})

test('bounded titles and notifications do not split surrogate pairs', () => {
  const text = `${'😀'.repeat(59)}a😀`
  assert.equal(sanitizeTitle(text).endsWith('😀'), true)
  assert.equal(sanitizeNotification(text).endsWith('😀'), true)
})
