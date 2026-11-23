import { join } from 'node:path'
import { createDurableBraidApplication } from '../../src/app/composition.js'
import type { ProductionCompositionConfig } from '../../src/app/production-composition.js'
import { RandomIds } from '../../src/ports/ids.js'
import { FileCredentialStore } from './file-credentials.js'

// Sends one CLI Bridge turn, reports its run once the provider cursor is committed, and stays
// live until the parent kills it, as a fleet lane's braid client dies mid-turn.
const root = process.env.RESTART_ROOT ?? ''
const configuration = JSON.parse(
  process.env.RESTART_CONFIGURATION ?? '{}',
) as ProductionCompositionConfig
const { app } = await createDurableBraidApplication({
  path: join(root, 'braid.db'),
  workspaceRoot: root,
  credentialStore: new FileCredentialStore(join(root, 'credentials')),
  production: configuration,
  ids: new RandomIds(),
})
app.initialize(root)
await app.whenDurable()
const send = app.send({
  operationId: 'operation-killed-client-send',
  text: 'Keep working while Braid is killed.',
})
await send.admissionReady
while ((app.state().runs[0]?.lastProviderSequence ?? 0) < 2) {
  await new Promise((resolve) => setTimeout(resolve, 1))
}
await app.whenDurable()
process.stdout.write(`ready ${send.runId}\n`)
setInterval(() => undefined, 60_000)
