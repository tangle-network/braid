import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalDigest, canonicalJson } from '../src/domain/canonical.js'
import { canonicalRequestIdentity } from '../src/views/shared/canonical.js'

test('request identity does not depend on the order members were written in', () => {
  assert.equal(
    canonicalRequestIdentity({ version: 1, method: 'state', requestId: 'req-1' }),
    canonicalRequestIdentity({ requestId: 'req-1', method: 'state', version: 1 }),
  )
})

test('request identity refuses a value with no faithful JSON form', () => {
  // Each of these once produced an identity, and the first two produced the
  // SAME identity as `null` - so a request identifier reused with different
  // input read as a replay of the first request rather than a conflict.
  for (const [label, value] of [
    ['not a number', { params: { limit: Number.NaN } }],
    ['infinite', { params: { limit: Number.POSITIVE_INFINITY } }],
    [
      'a class instance',
      {
        params: new (class Params {
          limit = 1
        })(),
      },
    ],
    [
      'a cycle',
      (() => {
        const request: Record<string, unknown> = { method: 'state' }
        request.self = request
        return request
      })(),
    ],
    ['nothing', undefined],
  ] as const) {
    assert.throws(() => canonicalRequestIdentity(value), TypeError, label)
  }
})

test('a request identity is the canonical text, and a domain digest is a hash of it', () => {
  const request = { version: 1, method: 'state', requestId: 'req-1' }
  assert.equal(canonicalRequestIdentity(request), canonicalJson(request))
  assert.match(canonicalDigest(request), /^[0-9a-f]{64}$/)
  assert.notEqual(canonicalDigest(request), canonicalRequestIdentity(request))
})
