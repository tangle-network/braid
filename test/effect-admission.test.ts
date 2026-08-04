import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import { credentialRef } from '../src/ports/credentials.js'
import { FileCredentialStore } from './support/file-credentials.js'

const require = createRequire(import.meta.url)
const sqliteAvailable = (() => {
  try {
    require('better-sqlite3-multiple-ciphers')
    return true
  } catch {
    return false
  }
})()

const childPath = join(process.cwd(), '.test-dist/test/effect-admission-child.js')

test('two SQLite processes admit one external effect', async () => {
  if (!sqliteAvailable) {
    throw new Error(
      'W5_NATIVE_STORAGE_BLOCKED: better-sqlite3-multiple-ciphers@12.11.1 is not installed',
    )
  }
  const root = await mkdtemp(join(tmpdir(), 'braid-effect-admission-'))
  const logPath = join(root, 'dispatch.log')
  await writeFile(logPath, '', { mode: 0o600 })
  const storage = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new FileCredentialStore(join(root, 'credentials')),
    databaseKeyRef: credentialRef('cred:v1:effect-admission-test'),
  })
  await storage.close()

  await Promise.all(
    [0, 1].map(
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [childPath], {
            cwd: process.cwd(),
            env: { ...process.env, EFFECT_ROOT: root, EFFECT_LOG: logPath },
            stdio: ['ignore', 'ignore', 'pipe'],
          })
          let stderr = ''
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8')
          })
          child.once('error', reject)
          child.once('close', (code, signal) => {
            if (code !== 0 || signal !== null) {
              reject(
                new Error(
                  `effect child exited with code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
                ),
              )
              return
            }
            resolve()
          })
        }),
    ),
  )
  const dispatches = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean)
  assert.equal(dispatches.length, 1)
})
