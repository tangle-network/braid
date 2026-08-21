import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import { StorageError } from '../src/adapters/storage/sqlite-errors.js'
import { SerializedEffectCoordinator } from '../src/app/effect-coordinator.js'
import { FixedClock } from '../src/ports/clock.js'
import { credentialRef } from '../src/ports/credentials.js'
import { FileCredentialStore } from './support/file-credentials.js'

const root = required('EFFECT_ROOT')
const logPath = required('EFFECT_LOG')

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

let storage: Awaited<ReturnType<typeof openSqliteStorage>> | undefined
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    storage = await openSqliteStorage({
      path: join(root, 'braid.sqlite'),
      workspaceRoot: root,
      credentialStore: new FileCredentialStore(join(root, 'credentials')),
      databaseKeyRef: credentialRef('cred:v1:effect-admission-test'),
    })
    break
  } catch (error) {
    if (!(error instanceof StorageError) || error.code !== 'STORAGE_LOCKED' || attempt === 99) {
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
if (storage === undefined) throw new Error('effect-admission child could not open storage')

try {
  const coordinator = new SerializedEffectCoordinator(storage, new FixedClock())
  const handle = coordinator.start(
    {
      operationId: 'op-two-process-admission',
      effectKind: 'test.external-mutation',
      request: { value: 'same request' },
    },
    {
      dispatch: async () => {
        await appendFile(logPath, 'dispatch\n', { mode: 0o600 })
        await new Promise((resolve) => setTimeout(resolve, 50))
        return { status: 'acknowledged', externalReference: 'test-reference' }
      },
    },
  )
  await handle.completion
} finally {
  await storage.close()
}
