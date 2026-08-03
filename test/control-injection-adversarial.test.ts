import assert from 'node:assert/strict'
import test from 'node:test'
import { redactSensitiveText } from '../src/domain/redaction.js'
import { sanitizeForSurface } from '../src/views/shared/sanitize.js'

test('DCS, PM, and APC string sequences are stripped with their bodies', () => {
  assert.equal(redactSensitiveText('a\u001bP1;2;3qdcspayload\u001b\\b'), 'ab')
  assert.equal(redactSensitiveText('a\u001b^pm-payload\u001b\\b'), 'ab')
  assert.equal(redactSensitiveText('a\u001b_apc-payload\u001b\\b'), 'ab')
})

test('SOS string sequences are stripped with their bodies', () => {
  // ECMA-48 SOS (\u001bX) is one of the four string-introducer escapes that a
  // terminal-control stripper must consume wholesale alongside DCS/PM/APC.
  assert.equal(redactSensitiveText('a\u001bXsos-payload\u001b\\b'), 'ab')
})

test('an OSC sequence terminated by the two-byte ST form is stripped', () => {
  assert.equal(redactSensitiveText('a\u001b]0;title\u001b\\b'), 'ab')
  assert.equal(redactSensitiveText('a\u009d0;title\u001b\\b'), 'ab')
})

test('an unterminated control sequence emits nothing after its last safe byte', () => {
  assert.equal(redactSensitiveText('safe\u001b[31'), 'safe')
  assert.equal(redactSensitiveText('\u001b[31'), '')
})

test('C1-introduced CSI and OSC sequences are stripped', () => {
  assert.equal(redactSensitiveText('x\u009b31mred\u009b0my'), 'xredy')
  assert.equal(redactSensitiveText('x\u009d0;owned\u0007y'), 'xy')
})

test('sanitizeForSurface reports accurate control and bidi removal flags', () => {
  const clean = sanitizeForSurface('plain printable text', 'text')
  assert.equal(clean.removedControls, false)
  assert.equal(clean.removedBidi, false)

  const controls = sanitizeForSurface('text\u001b[0mmore', 'text')
  assert.equal(controls.removedControls, true)
  assert.equal(controls.value.includes('\u001b'), false)

  const bidi = sanitizeForSurface('text \u202e override', 'text')
  assert.equal(bidi.removedBidi, true)
  assert.equal(bidi.value.includes('\u202e'), false)
})
