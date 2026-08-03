import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson } from '../src/domain/canonical.js'
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
