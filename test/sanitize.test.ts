import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeTerminalText } from '../src/views/shared/sanitize.js'

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
