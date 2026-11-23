import { join } from 'node:path'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { createDurableBraidApplication } from '../../src/app/composition.js'
import type { ConnectionRecord } from '../../src/domain/entities.js'
import { createConnectionId } from '../../src/domain/ids.js'
import { RandomIds } from '../../src/ports/ids.js'
import { FileCredentialStore } from './file-credentials.js'

/** A durable Braid that starts one held CLI Bridge run, reports it, and waits to be killed. */
const root = process.env.RETAINED_RESTART_ROOT ?? ''
const now = '2026-08-11T12:00:00.000Z'
const connection: ConnectionRecord = {
  id: createConnectionId('connection-retained-restart'),
  kind: 'cli-bridge',
  name: 'Local CLI Bridge',
  endpoint: process.env.RETAINED_RESTART_ENDPOINT ?? '',
  providerOptions: { transport: 'local' },
  createdAt: now,
  updatedAt: now,
  lastHealth: { status: 'unknown' },
}
const { app } = await createDurableBraidApplication({
  path: join(root, 'braid.db'),
  workspaceRoot: root,
  credentialStore: new FileCredentialStore(join(root, 'credentials')),
  production: {
    profile: defineAgentProfile({
      name: 'Retained restart proof',
      harness: 'pi',
      model: { provider: 'openai', default: 'openai/gpt-5' },
    }),
    connections: [connection],
    connectionId: connection.id,
  },
  ids: new RandomIds(),
})
app.initialize(root)
await app.whenDurable()
const sent = app.send({
  operationId: 'operation-killed-restart-send',
  text: 'Keep working while Braid is killed.',
})
void sent.completion.catch(() => undefined)
await sent.admissionReady
while ((app.state().runs[0]?.lastProviderSequence ?? 0) < 2)
  await new Promise((resolve) => setTimeout(resolve, 5))
await app.whenDurable()
process.send?.({ ready: true, runId: sent.runId })
setInterval(() => undefined, 60_000)
