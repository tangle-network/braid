import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const [packageRootValue, storageRootValue] = process.argv.slice(2)
assert(packageRootValue && storageRootValue, 'Package and storage roots are required')
const packageRoot = resolve(packageRootValue)
const storageRoot = resolve(storageRootValue)
const braid = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href)
const privateFiles = await import(
  pathToFileURL(join(packageRoot, 'dist', 'adapters', 'persistence', 'safe-file.js')).href
)
const privatePath = join(storageRoot, 'private', 'platform-smoke.json')
privateFiles.ensurePrivateDirectory(dirname(privatePath))
privateFiles.writePrivateFile(privatePath, 'first')
assert(privateFiles.readNoFollow(privatePath, 32)?.toString('utf8') === 'first', 'Write failed')
privateFiles.replacePrivateFile(privatePath, 'second', { overwrite: true })
assert(privateFiles.readNoFollow(privatePath, 32)?.toString('utf8') === 'second', 'Replace failed')
privateFiles.removePrivateFile(privatePath)
assert(privateFiles.readNoFollow(privatePath, 32) === undefined, 'Remove failed')
const credentials = new braid.MemoryCredentialStore()
const storage = await braid.openSqliteStorage({
  path: join(storageRoot, 'braid.sqlite'),
  workspaceRoot: storageRoot,
  credentialStore: credentials,
  databaseKeyRef: braid.credentialRef('cred:v1:platform-smoke'),
})
try {
  const event = {
    workspaceId: braid.createWorkspaceId('workspace-platform-smoke'),
    conversationId: braid.createConversationId('conversation-platform-smoke'),
    runId: braid.createRunId('run-platform-smoke'),
    eventId: braid.createEventId('event-platform-smoke'),
    sequence: 1,
    kind: 'run.finished',
    payload: { platform: process.platform },
    occurredAt: '2026-08-09T00:00:00.000Z',
    terminal: true,
  }
  await storage.append([event])
  assert((await storage.replay({ runId: event.runId })).events.length === 1, 'Replay failed')
  assert((await storage.integrity()).ok === true, 'Encrypted storage integrity failed')
} finally {
  await storage.close()
}
process.stdout.write(`${JSON.stringify({ encryptedStorage: true, privateFiles: true })}\n`)
