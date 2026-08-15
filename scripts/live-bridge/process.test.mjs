import assert from 'node:assert/strict'
import test from 'node:test'
import { managedSpawn, terminateProcess } from './process.mjs'

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('close', resolve))
}

test('termination evidence marks a naturally exited process as unsignalled', async () => {
  const child = await managedSpawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  })
  await waitForClose(child)

  const result = await terminateProcess(child, { termTimeoutMs: 100, killTimeoutMs: 100 })

  assert.equal(result.initialExited, true)
  assert.equal(result.termSent, false)
  assert.equal(result.killSent, false)
  assert.equal(result.cleanupStatus, 'already-exited')
})

test('termination evidence records signal-driven process-tree cleanup', async () => {
  const child = await managedSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })

  const result = await terminateProcess(child, { termTimeoutMs: 1_000, killTimeoutMs: 1_000 })

  assert.equal(result.initialExited, false)
  assert.equal(result.initialTree.supported, true)
  assert.equal(result.initialTree.gone, false)
  assert.equal(result.termSent || result.killSent, true)
  assert.equal(result.exited, true)
  assert.equal(result.descendantsExited, true)
  assert.equal(result.descendantsVerified, true)
  assert.notEqual(result.cleanupStatus, 'already-exited')
})
