import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesKey, setKittyProtocolActive } from '@earendil-works/pi-tui'

test('keyboard bindings accept legacy and Kitty encodings with fallback', () => {
  setKittyProtocolActive(false)
  assert.equal(matchesKey('\u0010', 'ctrl+p'), true)
  assert.equal(matchesKey('\u001b[200~paste\u001b[201~', 'escape'), false)
  setKittyProtocolActive(true)
  assert.equal(matchesKey('\u001b[112;5u', 'ctrl+p'), true)
  setKittyProtocolActive(false)
})
