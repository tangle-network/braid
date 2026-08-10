import assert from 'node:assert/strict'

// Keep these patterns aligned with src/domain/secret-sanitizer.ts.
const SECRET_ASSIGNMENT =
  /(^|[\s,;{[(])(?:password|passwd|passphrase|token|secret|credential|authorization|auth|key|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|signature|cookie|header|query|fragment)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\])}]*)/iu
const BEARER_ASSIGNMENT = /\bBearer(?:\s+|\s*=\s*)[^\s,;]*/iu
const BARE_CREDENTIAL =
  /(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})/u

const PUBLIC_CREDENTIAL_PATTERNS = [
  ['credential assignment', SECRET_ASSIGNMENT],
  ['bearer credential', BEARER_ASSIGNMENT],
  ['bare credential', BARE_CREDENTIAL],
]

export function assertPublicCapture(value) {
  assert.equal(typeof value, 'string', 'Public capture must be text')
  for (const [label, pattern] of PUBLIC_CREDENTIAL_PATTERNS) {
    assert.doesNotMatch(value, pattern, `Public capture contains a ${label}`)
  }
  assert.doesNotMatch(value, /fixture\/deterministic|repeatable demo data/iu)
}
