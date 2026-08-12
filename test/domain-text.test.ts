import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson } from '../src/domain/canonical.js'
import { redactSensitiveText, sanitizeTextChunks } from '../src/domain/secret-sanitizer.js'
import { containsUnsafeControlCharacter, isCanonicalIsoDateTime } from '../src/domain/text.js'

test('unsafe diagnostic controls are rejected without rejecting normal whitespace', () => {
  for (const code of [0, 1, 8, 11, 12, 14, 31, 127]) {
    assert.equal(containsUnsafeControlCharacter(String.fromCharCode(code)), true)
  }
  for (const value of ['plain text', '\t', '\n', '\r', '\u0080']) {
    assert.equal(containsUnsafeControlCharacter(value), false)
  }
})

test('canonical timestamps reject parseable but non-canonical dates', () => {
  assert.equal(isCanonicalIsoDateTime('2026-08-02T00:00:00.000Z'), true)
  for (const value of ['1', '2026-8-2', '2026-02-30T00:00:00.000Z', '2026-08-02T00:00:00Z']) {
    assert.equal(isCanonicalIsoDateTime(value), false, value)
  }
})

test('canonical JSON uses locale-independent key ordering and rejects ambiguous values', () => {
  assert.equal(canonicalJson({ z: 1, ä: 2, a: 3 }), '{"a":3,"z":1,"ä":2}')
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite numbers/u)
  assert.throws(() => canonicalJson([undefined]), /undefined array/u)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(() => canonicalJson(cyclic), /cycles/u)
})

test('known bare credential formats are removed across every stream boundary', () => {
  const credentials = [
    'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', // sample credential
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', // sample credential
    'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH', // sample credential
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789', // sample credential
    'AKIA1234567890ABCDEF', // sample credential
    'AIza1234567890abcdefghijklmnopqrstuvwxyz', // sample credential
    ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnop'].join('-'), // sample credential
  ]
  for (const credential of credentials) {
    const source = `before ${credential} after`
    assert.equal(redactSensitiveText(source), 'before [redacted credential] after')
    for (let boundary = 0; boundary <= source.length; boundary += 1) {
      assert.equal(
        sanitizeTextChunks([source.slice(0, boundary), source.slice(boundary)]),
        'before [redacted credential] after',
        `${credential.slice(0, 8)} split at ${boundary}`,
      )
    }
  }
  const longCredential = credentials[0] as string
  const prefix = 'x'.repeat(4_500)
  const suffix = ` after${'z'.repeat(994)}`
  const longSource = `${prefix}${longCredential}${suffix}`
  const expected = `${prefix}[redacted credential]${suffix}`
  assert.equal(sanitizeTextChunks([longSource]), expected)
  assert.equal(
    sanitizeTextChunks([
      longSource.slice(0, 4_097),
      longSource.slice(4_097, 4_530),
      longSource.slice(4_530),
    ]),
    expected,
  )
})

test('phrase-form credential assignments are removed across stream boundaries', () => {
  const source = 'Provider rejected API key: sk-live-sentinel-1234567890'
  const expected = 'Provider rejected [redacted secret]'
  assert.equal(redactSensitiveText(source), expected)
  for (let boundary = 0; boundary <= source.length; boundary += 1) {
    assert.equal(
      sanitizeTextChunks([source.slice(0, boundary), source.slice(boundary)]),
      expected,
      `split at ${boundary}`,
    )
  }
})
