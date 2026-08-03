import assert from 'node:assert/strict'
import test from 'node:test'
import { getCapabilities, setCapabilities } from '@earendil-works/pi-tui'
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
