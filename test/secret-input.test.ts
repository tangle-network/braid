import assert from 'node:assert/strict'
import test from 'node:test'
import { StdinBuffer, visibleWidth } from '@earendil-works/pi-tui'
import { MaskedSecretInput, type OwnedSecretBytes } from '../src/views/tui/secret-input.js'

const encoder = new TextEncoder()

test('masks input and submits mutable caller-owned UTF-8 bytes', () => {
  const submitted: OwnedSecretBytes[] = []
  const input = new MaskedSecretInput({ onSubmit: (bytes) => submitted.push(bytes) })
  input.focused = true
  input.handleInput('top-secret')

  const rendered = input.render(40).join('\n')
  assert.doesNotMatch(rendered, /top-secret/u)
  assert.match(rendered, /••••••••••/u)
  assert.equal(JSON.stringify(input).includes('top-secret'), false)

  input.handleInput('\r')

  assert.equal(submitted.length, 1)
  const bytes = submitted[0]
  assert.ok(bytes instanceof Uint8Array)
  assert.notEqual(typeof bytes, 'string')
  assert.deepEqual([...bytes], [...encoder.encode('top-secret')])
  bytes.fill(0)
  assert.deepEqual(
    [...bytes],
    Array.from({ length: encoder.encode('top-secret').length }, () => 0),
  )
  assert.equal(input.render(40).join('').includes('top-secret'), false)
})

test('supports bracketed paste, grapheme-aware backspace, forward delete, and cursor movement', () => {
  const submitted: OwnedSecretBytes[] = []
  const input = new MaskedSecretInput({ onSubmit: (bytes) => submitted.push(bytes) })

  input.handleInput('\u001b[200~a😀b\n\tc\u001b[20')
  input.handleInput('1~')
  input.handleInput('\u001b[D')
  input.handleInput('\u007f')
  input.handleInput('\u001b[H')
  input.handleInput('\u001b[C')
  input.handleInput('\u001b[3~')
  input.handleInput('\u001b[F')
  input.handleInput('!')
  input.handleInput('\r')

  assert.equal(submitted.length, 1)
  const bytes = submitted[0]
  assert.ok(bytes)
  assert.deepEqual([...bytes], [...encoder.encode('ab   c!')])
  bytes.fill(0)
})

test('accepts Pi split Unicode input and deletes a complete grapheme', () => {
  const stdin = new StdinBuffer({ timeout: 1000 })
  const sequences: string[] = []
  stdin.on('data', (sequence) => sequences.push(sequence))
  stdin.process('👩🏽‍💻')
  stdin.destroy()

  const submitted: OwnedSecretBytes[] = []
  const input = new MaskedSecretInput({ onSubmit: (bytes) => submitted.push(bytes) })
  for (const sequence of sequences) input.handleInput(sequence)
  input.handleInput('\r')

  assert.ok(submitted[0])
  assert.deepEqual([...submitted[0]], [...encoder.encode('👩🏽‍💻')])
  submitted[0].fill(0)

  const deleted: OwnedSecretBytes[] = []
  const deleteInput = new MaskedSecretInput({ onSubmit: (bytes) => deleted.push(bytes) })
  for (const sequence of sequences) deleteInput.handleInput(sequence)
  deleteInput.handleInput('\u007f')
  deleteInput.handleInput('\r')
  assert.ok(deleted[0])
  assert.deepEqual([...deleted[0]], [])
  deleted[0].fill(0)
})

test('escape and Ctrl+C cancel, clear the field, and prevent later callbacks', () => {
  let cancelled = 0
  let submitted = 0
  const input = new MaskedSecretInput({
    onCancel: () => {
      cancelled += 1
    },
    onSubmit: () => {
      submitted += 1
    },
  })

  input.handleInput('cancel-me')
  input.handleInput('\u001b')
  input.handleInput('\r')
  input.handleInput('late-input')
  input.handleInput('\u0003')

  assert.equal(cancelled, 1)
  assert.equal(submitted, 0)
  assert.doesNotMatch(input.render(40).join('\n'), /cancel-me|late-input/u)

  const ctrlInput = new MaskedSecretInput({
    onCancel: () => {
      cancelled += 1
    },
  })
  ctrlInput.handleInput('ctrl-c-secret')
  ctrlInput.handleInput('\u0003')

  assert.equal(cancelled, 2)
  assert.doesNotMatch(ctrlInput.render(40).join('\n'), /ctrl-c-secret/u)
})

test('dispose zeroes the active field and keeps renders bounded', () => {
  const input = new MaskedSecretInput()
  input.focused = true
  input.handleInput('dispose-me')
  input.dispose()
  input.handleInput('after-dispose')

  for (const width of [0, 1, 2, 3, 8, 40]) {
    const lines = input.render(width)
    assert.equal(lines.length, 1)
    assert.ok(lines.every((line) => visibleWidth(line) <= width))
    assert.doesNotMatch(lines.join('\n'), /dispose-me|after-dispose/u)
  }
})
