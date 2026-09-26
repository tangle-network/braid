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

test('authorization schemes redact the credential after the scheme across stream boundaries', () => {
  const sources = [
    'authorization: Basic BASIC-ASSIGNMENT-CANARY suffix',
    'authorization=Bearer BEARER-ASSIGNMENT-CANARY suffix',
    'token: Bearer TOKEN-ASSIGNMENT-CANARY suffix',
    'x=Bearer STANDALONE-BEARER-CANARY suffix',
  ]
  for (const source of sources) {
    const expected = redactSensitiveText(source)
    assert.doesNotMatch(
      expected,
      /(?:BASIC|BEARER|TOKEN)-ASSIGNMENT-CANARY|STANDALONE-BEARER-CANARY/u,
    )
    for (let boundary = 0; boundary <= source.length; boundary += 1) {
      assert.equal(
        sanitizeTextChunks([source.slice(0, boundary), source.slice(boundary)]),
        expected,
        `${source.slice(0, 24)} at ${boundary}`,
      )
    }
  }
})

test('regression: quoted, escaped and prefixed secret names never leak at any stream split', async () => {
  const { IncrementalSecretTextSanitizer } = await import('../src/domain/secret-sanitizer.js')
  const canary = 'canary7Q3z'
  const inputs = [
    `{"token":"${canary}"}`,
    `{"api_key": "${canary}"}`,
    `{\\"token\\":\\"${canary}\\"}`,
    `TANGLE_API_KEY=${canary}`,
    `export OPENAI_API_KEY="${canary}"`,
    `X-Api-Key: ${canary}`,
    `'client_secret': '${canary}'`,
  ]
  for (const input of inputs) {
    assert.doesNotMatch(redactSensitiveText(input), new RegExp(canary), `batch: ${input}`)
    for (let split = 0; split <= input.length; split += 1) {
      const chunks = [input.slice(0, split), input.slice(split)]
      assert.doesNotMatch(
        sanitizeTextChunks(chunks),
        new RegExp(canary),
        `chunks@${split}: ${input}`,
      )
      const incremental = new IncrementalSecretTextSanitizer()
      const streamed =
        chunks.map((chunk) => incremental.push(chunk)).join('') + incremental.finish()
      assert.doesNotMatch(streamed, new RegExp(canary), `incremental@${split}: ${input}`)
    }
  }
  assert.equal(redactSensitiveText('sort order: ascending'), 'sort order: ascending')
})

test('regression: overflow preserves bearer, quoted-value and Unicode URL boundaries', async () => {
  const { IncrementalSecretTextSanitizer } = await import('../src/domain/secret-sanitizer.js')
  const suffix = ' ordinary-after'
  const cases = [
    { input: `before Bearer ${'b'.repeat(16_384)}${suffix}`, canary: 'b'.repeat(128) },
    {
      input: `before {"token":"${'q'.repeat(6_000)} ${'w'.repeat(8_000)}"}${suffix}`,
      canary: 'w'.repeat(128),
    },
    {
      input: `before ${JSON.stringify({ token: 'first" second-secret-canary' })}${suffix}`,
      canary: 'second-secret-canary',
    },
    {
      input: `before ${JSON.stringify({ token: `${'q'.repeat(6_000)}" second-secret-canary` })}${suffix}`,
      canary: 'second-secret-canary',
    },
    {
      input: `before ${JSON.stringify(JSON.stringify({ token: `${'q'.repeat(6_000)}" second-secret-canary` })).slice(1, -1)}${suffix}`,
      canary: 'second-secret-canary',
    },
    {
      input: `before https://user:${'🙂'.repeat(5_000)}URL-TAIL-CANARY@owned.invalid/path${suffix}`,
      canary: 'URL-TAIL-CANARY',
    },
  ]
  for (const { input, canary } of cases) {
    const batch = redactSensitiveText(input)
    assert(!batch.includes(canary))
    assert(batch.includes(suffix))
    for (const step of [613, 2_048]) {
      const stream = new IncrementalSecretTextSanitizer()
      let output = ''
      for (let offset = 0; offset < input.length; offset += step)
        output += stream.push(input.slice(offset, offset + step))
      output += stream.finish()
      assert(!output.includes(canary))
      assert(output.includes(suffix))
    }
  }
  const prefix = `${'x'.repeat(4_076)} Bearer `
  assert.equal(prefix.length, 4_084)
  const chunks = [prefix + 'c'.repeat(1_024), 'c'.repeat(5_000), '\nordinary-after']
  assert.equal(sanitizeTextChunks(chunks), `${'x'.repeat(4_076)} [redacted bearer]\nordinary-after`)
})

test('regression: the README first run creates a profile Braid can load', async () => {
  const { readFileSync, mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { trustedProfileSources } = await import('../src/bin/production-profile-projection.js')
  const { resolveProfileSource } = await import('../src/app/profile-sources.js')
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
  const block = /cat > \.braid\/profile\.json <<'EOF'\n([\s\S]*?)\nEOF\n/u.exec(readme)
  assert.ok(block?.[1], 'README must show how to create .braid/profile.json before the first run')
  const workspace = mkdtempSync(join(tmpdir(), 'braid-readme-first-run-'))
  mkdirSync(join(workspace, '.braid'))
  writeFileSync(join(workspace, '.braid', 'profile.json'), `${block[1]}\n`)
  const [source] = trustedProfileSources({ workspace } as Parameters<
    typeof trustedProfileSources
  >[0])
  assert.ok(source)
  const record = await resolveProfileSource(source)
  assert.equal(record.profile.name, 'Coding agent')
})
