import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isSensitiveFieldName,
  redactBraidEvent,
  redactProviderError,
  redactStructuredValue,
  redactSensitiveText,
  redactSensitiveUrls,
} from '../src/domain/redaction.js'

test('a redacted secret URL preserves trailing punctuation in surrounding prose', () => {
  const redacted = redactSensitiveUrls(
    'see https://provider.example/?token=CANARY-Leak-1). and https://ok.example/x.',
  )
  assert.equal(redacted.includes('CANARY-Leak-1'), false)
  assert.equal(redacted.includes('[redacted link]).'), true)
  assert.equal(redacted.includes('https://ok.example/x.'), true)
})

test('multiple bearer tokens of mixed case are all redacted in one pass', () => {
  const redacted = redactSensitiveText('Bearer AAA-LEAK then bearer BBB-LEAK then BEARER CCC')
  assert.equal(redacted.includes('AAA-LEAK'), false)
  assert.equal(redacted.includes('BBB-LEAK'), false)
  assert.equal(redacted.includes('CCC'), false)
  assert.equal(redacted.match(/\[redacted bearer\]/gu)?.length, 3)
})

test('redactProviderError keeps each input branch distinct and scrubs secrets', () => {
  assert.equal(
    redactProviderError(new Error('boom https://user:pw@host/?token=CANARY Bearer CANARY')),
    'boom [redacted link] [redacted bearer]',
  )
  assert.equal(redactProviderError('plain Bearer CANARY-STR'), 'plain [redacted bearer]')
  assert.equal(redactProviderError({ notAnError: true }), 'Provider error')
  assert.equal(redactProviderError(42), 'Provider error')
  assert.equal(redactProviderError(null), 'Provider error')
})

test('isSensitiveFieldName flags structural secret names and ignores benign ones', () => {
  for (const sensitive of [
    'headers',
    'cookies',
    'mcp',
    'attestation',
    'profile',
    'credentials',
    'query',
    'apiKey',
    'session_id',
  ]) {
    assert.equal(isSensitiveFieldName(sensitive), true, sensitive)
  }
  for (const benign of ['description', 'summary', 'title', 'runner', 'messageCount']) {
    assert.equal(isSensitiveFieldName(benign), false, benign)
  }
})

test('redactStructuredValue blanks sensitive keys at any depth without collapsing structure', () => {
  const input = {
    a: { token: 'CANARY-A' },
    list: [{ apiKey: 'CANARY-B' }, { keep: 'preserve' }],
    neutral: 'stays',
  }
  const redacted = redactStructuredValue(input) as typeof input
  assert.equal(redacted.a.token, '[redacted]')
  assert.equal(redacted.list[0]?.apiKey, '[redacted]')
  assert.equal(redacted.list[1]?.keep, 'preserve')
  assert.equal(redacted.neutral, 'stays')
  assert.equal(JSON.stringify(redacted).includes('CANARY'), false)
})

test('redactBraidEvent sanitizes provider-authored strings without blanking structural keys', () => {
  const event = redactBraidEvent({
    kind: 'run.text.delta',
    runId: 'run-keep',
    text: '\u001b[31mc\u001b[0m Bearer CANARY https://user:pw@host/?token=CANARY',
  })
  assert.equal(event.kind, 'run.text.delta')
  assert.equal(event.runId, 'run-keep')
  assert.equal(event.text.includes('\u001b'), false)
  assert.equal(event.text.includes('CANARY'), false)
  assert.match(event.text, /\[redacted bearer\]/u)
  assert.match(event.text, /\[redacted link\]/u)
})
