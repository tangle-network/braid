import assert from 'node:assert/strict'
import test from 'node:test'
import { getCapabilities, setCapabilities } from '@earendil-works/pi-tui'
import {
  boundVisibleText,
  MAX_RENDERED_TEXT_CHARS,
  MAX_RENDERED_TEXT_LINES,
  redactStructuredValue,
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

test('terminal sanitizer removes every control-string family in 7-bit and C1 forms', () => {
  const cases = [
    {
      name: 'OSC 7-bit BEL',
      terminated: '\u001b]0;owned\u0007',
      unterminated: '\u001b]0;owned',
    },
    {
      name: 'OSC 7-bit ST',
      terminated: '\u001b]0;owned\u001b\\',
      unterminated: '\u001b]0;owned',
    },
    {
      name: 'OSC C1 ST',
      terminated: '\u009d0;owned\u009c',
      unterminated: '\u009d0;owned',
    },
    {
      name: 'DCS 7-bit ST',
      terminated: '\u001bP1;2+qowned\u001b\\',
      unterminated: '\u001bP1;2+qowned',
    },
    {
      name: 'DCS C1 ST',
      terminated: '\u00901;2+qowned\u009c',
      unterminated: '\u00901;2+qowned',
    },
    {
      name: 'SOS 7-bit ST',
      terminated: '\u001bXowned\u001b\\',
      unterminated: '\u001bXowned',
    },
    {
      name: 'SOS C1 ST',
      terminated: '\u0098owned\u009c',
      unterminated: '\u0098owned',
    },
    {
      name: 'PM 7-bit ST',
      terminated: '\u001b^owned\u001b\\',
      unterminated: '\u001b^owned',
    },
    {
      name: 'PM C1 ST',
      terminated: '\u009eowned\u009c',
      unterminated: '\u009eowned',
    },
    {
      name: 'APC 7-bit ST',
      terminated: '\u001b_owned\u001b\\',
      unterminated: '\u001b_owned',
    },
    {
      name: 'APC C1 ST',
      terminated: '\u009fowned\u009c',
      unterminated: '\u009fowned',
    },
    {
      name: 'CSI 7-bit',
      terminated: '\u001b[31m',
      unterminated: '\u001b[31',
    },
    {
      name: 'CSI C1',
      terminated: '\u009b31m',
      unterminated: '\u009b31',
    },
  ] as const

  for (const { name, terminated, unterminated } of cases) {
    assert.equal(sanitizeTerminalText(`before${terminated}after`), 'beforeafter', name)
    assert.equal(sanitizeTerminalText(`before${unterminated}`), 'before', `${name} at EOF`)
  }
})

test('terminal sanitizer keeps mixed control bodies suppressed without swallowing adjacent text', () => {
  const mixed = 'before\u001bPouter\u001b]nested\u0007\u001b[31m\u001bXalso nested\u009cafter'
  const csiWithString = 'before\u001b[\u001bXhidden\u001b\\after'
  const repeatedEscape = 'before\u001b\u001bXhidden\u001b\\after'

  assert.equal(sanitizeTerminalText(mixed), 'beforeafter')
  assert.equal(sanitizeTerminalText(csiWithString), 'beforeafter')
  assert.equal(sanitizeTerminalText(repeatedEscape), 'beforeafter')
  assert.equal(sanitizeTerminalText('before\u001b#8after'), 'beforeafter')
  assert.equal(sanitizeTerminalText('before\u001b#Xvisible'), 'beforevisible')
  assert.equal(sanitizeTerminalText('before\u001bXhidden\u0018after'), 'beforeafter')
})

test('all output-surface sanitizers share control removal and secret redaction', () => {
  const hostile = 'safe\u001bXhidden\u001b\\after Bearer CANARY'
  const expected = 'safeafter [redacted bearer]'
  const surfaceValues = [
    sanitizeTerminalText(hostile),
    sanitizeMarkdown(hostile),
    sanitizeDiff(hostile),
    sanitizeClipboardText(hostile),
    sanitizeTitle(hostile),
    sanitizeNotification(hostile),
    sanitizeImageAlt(hostile),
    redactStructuredValue({ text: hostile }),
  ]

  for (const value of surfaceValues) {
    assert.deepEqual(value, typeof value === 'object' ? { text: expected } : expected)
  }
})

test('bounded visible text stays within the renderer limits after sanitization', () => {
  const hugeControlBody = `before\u001bP${'hidden'.repeat(MAX_RENDERED_TEXT_CHARS)}\u001b\\after`
  assert.equal(boundVisibleText(hugeControlBody), 'beforeafter')

  const hugeText = Array.from(
    { length: MAX_RENDERED_TEXT_LINES + 100 },
    (_, index) => `row ${index}`,
  ).join('\n')
  const bounded = boundVisibleText(hugeText)
  assert.ok(Array.from(bounded).length <= MAX_RENDERED_TEXT_CHARS)
  assert.ok(bounded.split('\n').length <= MAX_RENDERED_TEXT_LINES + 1)
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
  const theme = createBraidTheme({ colors: false })
  const markdown = sanitizeMarkdown(
    '[safe](https://example.com/docs) [secret](https://user:CANARY@example.com/?token=CANARY) [script](javascript:alert(1)) [file](file:///etc/passwd) `https://example.com/?api_key=CANARY`',
  )
  try {
    for (const hyperlinks of [false, true]) {
      setCapabilities({ images: null, trueColor: false, hyperlinks })
      const rendered = new SafeMarkdown(markdown, 0, 0, theme.markdown).render(240).join('\n')
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

test('bounded titles and notifications do not split surrogate pairs', () => {
  const text = `${'😀'.repeat(59)}a😀`
  assert.equal(sanitizeTitle(text).endsWith('😀'), true)
  assert.equal(sanitizeNotification(text).endsWith('😀'), true)
})
