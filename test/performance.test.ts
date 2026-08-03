import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutFor } from '../src/views/tui/layout.js'
import { sanitizeTerminalText } from '../src/views/shared/sanitize.js'

test('terminal view transforms stay bounded across 10000 deterministic rows', () => {
  const started = performance.now()
  let total = 0
  for (let index = 0; index < 10_000; index += 1) {
    total += sanitizeTerminalText(`row ${index} 漢字 é 👩🏽‍💻\u001b[31m`).length
    layoutFor(40 + (index % 161), 12 + (index % 49))
  }
  const elapsed = performance.now() - started
  assert.ok(total > 0)
  assert.ok(elapsed < 2_000, `view transforms took ${elapsed.toFixed(1)}ms`)
})
