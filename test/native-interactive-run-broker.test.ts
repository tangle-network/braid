import assert from 'node:assert/strict'
import test from 'node:test'
import type { RetainedInteractiveRunHandle } from '@tangle-network/agent-runtime/kernel'
import { NativeInteractiveRunBroker } from '../src/adapters/runtime/native-interactive-run-broker.js'

const HANDLE = Object.freeze({ ref: Object.freeze({}) }) as unknown as RetainedInteractiveRunHandle

test('native interactive broker joins UI and execution regardless of arrival order', async () => {
  const broker = new NativeInteractiveRunBroker()
  const waiting = broker.waitForHandle('run-native')
  const lease = broker.open('run-native')
  lease.publish(HANDLE)
  assert.equal(await waiting, HANDLE)

  const outcome = lease.outcome()
  broker.settle('run-native', { kind: 'exited', exitCode: 0 })
  assert.deepEqual(await outcome, { kind: 'exited', exitCode: 0 })
  lease.close()
})

test('native interactive broker rejects duplicate execution and caller-local aborts', async () => {
  const broker = new NativeInteractiveRunBroker()
  const lease = broker.open('run-native')
  assert.throws(() => broker.open('run-native'), /already has an active execution/u)

  const abort = new AbortController()
  const waiting = broker.waitForHandle('run-native', { signal: abort.signal })
  abort.abort(new Error('viewer stopped'))
  await assert.rejects(waiting, /viewer stopped/u)

  lease.publish(HANDLE)
  assert.equal(await broker.waitForHandle('run-native'), HANDLE)
  lease.fail(new Error('execution failed'))
  await assert.rejects(lease.outcome(), /execution failed/u)
  lease.close()
})
