import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createDurableBraidApplication } from '../../src/startup/durable-runtime.js'
import { FileCredentialStore } from './file-credentials.js'

const [root, configuration, scenario] = process.argv.slice(2)
assert.ok(root && configuration)
const { app } = await createDurableBraidApplication({
  path: join(root, 'braid.db'),
  workspaceRoot: root,
  credentialStore: new FileCredentialStore(join(root, 'credentials')),
  production: JSON.parse(configuration),
})
app.initialize(root)
await app.whenDurable()
const cursor = Promise.withResolvers<void>()
app.subscribe((state) => {
  if (state.runs[0]?.lastCursor === '1:0') cursor.resolve()
})
const send = app.send({
  operationId: 'operation-crash',
  text: 'Keep working while Braid restarts.',
})
await Promise.race([cursor.promise, send.completion])
await app.whenDurable()
assert.equal(app.state().runs[0]?.lastCursor, '1:0')
if (scenario === 'queued follow-up')
  await app.queueInput({
    runId: send.runId,
    operationId: 'op-queued-before-crash',
    text: 'Continue the turn.',
  }).completion
process.kill(process.pid, 'SIGKILL')
