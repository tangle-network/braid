import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boundVisibleText,
  MAX_RENDERED_TEXT_CHARS,
  MAX_RENDERED_TEXT_LINES,
} from '../src/views/shared/sanitize.js'

test('visible text is bounded to the most recent line quota with an explicit marker', () => {
  const overLineQuota = MAX_RENDERED_TEXT_LINES + 25
  const lines = Array.from({ length: overLineQuota }, (_, index) => `line-${index}`).join('\n')
  const bounded = boundVisibleText(lines)
  const boundedLines = bounded.split('\n')

  assert.equal(boundedLines.length, MAX_RENDERED_TEXT_LINES + 1)
  assert.equal(boundedLines[0], '…')
  assert.equal(boundedLines[1], `line-25`)
  assert.equal(boundedLines.at(-1), `line-${overLineQuota - 1}`)
})

test('character-quota bounding keeps the marker and never splits a surrogate pair', () => {
  const overCharQuota = `${'x'.repeat(MAX_RENDERED_TEXT_CHARS + 64)}😀`
  const bounded = boundVisibleText(overCharQuota)

  assert.equal(bounded.startsWith('…\n'), true)
  assert.equal(bounded.endsWith('😀'), true)
  assert.ok(Array.from(bounded).length <= MAX_RENDERED_TEXT_CHARS)
})

test('when both quotas are exceeded the line bound runs first and the char bound runs second', () => {
  const longLine = 'y'.repeat(80)
  const input = Array.from({ length: MAX_RENDERED_TEXT_LINES + 40 }, () => longLine).join('\n')
  const bounded = boundVisibleText(input)

  assert.ok(bounded.startsWith('…\n'))
  assert.ok(bounded.length <= MAX_RENDERED_TEXT_CHARS)
})
