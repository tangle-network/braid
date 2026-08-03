import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  closeHeadlessKeyFile,
  openHeadlessKeyFile,
  readHeadlessKey,
  rejectEnvironmentKeySource,
} from '../src/adapters/credentials/headless-key.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import {
  LinuxSecretServiceCredentialStore,
  type NativeKeyringEntry,
  type NativeKeyringEntryFactory,
} from '../src/adapters/credentials/os.js'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import { assertPersistablePayload } from '../src/adapters/storage/sqlite-crypto.js'
import { StorageError } from '../src/adapters/storage/sqlite-errors.js'
import { credentialRef } from '../src/ports/credentials.js'
import { canonicalDigest } from '../src/domain/canonical.js'

test('headless key files require an external mode-0600 regular file and reject environment input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-headless-key-'))
  const workspace = join(root, 'workspace')
  const external = join(root, 'keys')
  const keyPath = join(external, 'database.key')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await mkdir(external, { recursive: true, mode: 0o700 })
  const key = Buffer.alloc(32, 7)
  await writeFile(keyPath, key, { mode: 0o600 })
  await chmod(keyPath, 0o600)

  assert.deepEqual(readHeadlessKey({ type: 'file', path: keyPath, workspaceRoot: workspace }), key)
  const fd = openHeadlessKeyFile(keyPath, workspace)
  try {
    assert.deepEqual(readHeadlessKey({ type: 'fd', fd, workspaceRoot: workspace }), key)
    assert.throws(
      () =>
        readHeadlessKey({
          type: 'fd',
          fd,
        } as Parameters<typeof readHeadlessKey>[0]),
      /workspace root/u,
    )
  } finally {
    closeHeadlessKeyFile(fd)
  }

  assert.throws(
    () =>
      readHeadlessKey({
        type: 'file',
        path: join(workspace, 'database.key'),
        workspaceRoot: workspace,
      }),
    /Cannot inspect key path|outside the workspace|unreadable/u,
  )
  await writeFile(join(workspace, 'database.key'), key, { mode: 0o600 })
  assert.throws(
    () =>
      readHeadlessKey({
        type: 'file',
        path: join(workspace, 'database.key'),
        workspaceRoot: workspace,
      }),
    /outside the workspace/u,
  )
  if (process.platform !== 'win32') {
    await chmod(keyPath, 0o644)
    assert.throws(
      () => readHeadlessKey({ type: 'file', path: keyPath, workspaceRoot: workspace }),
      /0600/u,
    )
    await chmod(keyPath, 0o600)
    const linkPath = join(external, 'database-link.key')
    await symlink(keyPath, linkPath)
    assert.throws(
      () => readHeadlessKey({ type: 'file', path: linkPath, workspaceRoot: workspace }),
      /Symlink/u,
    )
  }
  assert.throws(
    () => rejectEnvironmentKeySource('BRAID_KEY'),
    /Environment key sources are rejected/u,
  )
  key.fill(0)
})

test('headless key reads stay on one protected descriptor and reject hard links and oversized input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-headless-key-race-'))
  const workspace = join(root, 'workspace')
  const external = join(root, 'keys')
  const keyPath = join(external, 'database.key')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await mkdir(external, { recursive: true, mode: 0o700 })
  const original = Buffer.alloc(32, 11)
  const replacement = Buffer.alloc(32, 12)
  await writeFile(keyPath, original, { mode: 0o600 })
  await chmod(keyPath, 0o600)

  if (process.platform !== 'win32') {
    const openedPath = join(external, 'opened.key')
    const fd = openHeadlessKeyFile(keyPath, workspace)
    try {
      await rename(keyPath, openedPath)
      await writeFile(keyPath, replacement, { mode: 0o600 })
      assert.deepEqual(readHeadlessKey({ type: 'fd', fd, workspaceRoot: workspace }), original)
    } finally {
      closeHeadlessKeyFile(fd)
    }

    const hardLinkPath = join(external, 'database-hard-link.key')
    await link(keyPath, hardLinkPath)
    assert.throws(
      () => readHeadlessKey({ type: 'file', path: keyPath, workspaceRoot: workspace }),
      /exactly one filesystem link/u,
    )
  }

  const oversizedPath = join(external, 'oversized.key')
  await writeFile(oversizedPath, Buffer.alloc(129, 1), { mode: 0o600 })
  await chmod(oversizedPath, 0o600)
  assert.throws(
    () => readHeadlessKey({ type: 'file', path: oversizedPath, workspaceRoot: workspace }),
    /too large/u,
  )
  original.fill(0)
  replacement.fill(0)
})

test('native credential adapters keep secrets out of child processes and erase temporary buffers', async () => {
  const stored = new Map<string, Uint8Array>()
  let lastSet: Uint8Array | undefined
  let lastGet: Uint8Array | undefined
  const factory: NativeKeyringEntryFactory = (service, account): NativeKeyringEntry => {
    assert.equal(service, 'Braid')
    return {
      async setSecret(secret) {
        lastSet = secret
        stored.set(account, Uint8Array.from(secret))
      },
      async getSecret() {
        const secret = stored.get(account)
        lastGet = secret ? Uint8Array.from(secret) : undefined
        return lastGet
      },
      async deleteCredential() {
        return stored.delete(account)
      },
    }
  }
  const credentials = new LinuxSecretServiceCredentialStore(factory)
  const ref = credentialRef('cred:v1:native-round-trip')
  const input = Buffer.alloc(32, 19)
  await credentials.store({ ref, value: input })
  assert.deepEqual(input, Buffer.alloc(32, 19))
  assert.equal(
    lastSet?.every((byte) => byte === 0),
    true,
  )
  assert.equal(await credentials.available(), true)

  const handle = await credentials.resolve(ref)
  assert.equal(
    lastGet?.every((byte) => byte === 0),
    true,
  )
  assert.deepEqual(handle.read(), input)
  handle.dispose()
  assert.throws(() => handle.read(), /closed/u)
  await credentials.remove(ref)
  await credentials.remove(ref)
  await assert.rejects(
    () => credentials.resolve(ref),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'CREDENTIAL_NOT_FOUND',
  )

  const implementation = await readFile(
    join(process.cwd(), 'src/adapters/credentials/os.ts'),
    'utf8',
  )
  assert.doesNotMatch(implementation, /child_process|powershell|secret-tool|add-generic-password/u)
  input.fill(0)
})

test('native credential availability fails closed when the operating-system facility errors', async () => {
  const unavailableFactory: NativeKeyringEntryFactory = () => ({
    async setSecret() {
      throw Object.assign(new Error('service unavailable'), { code: 'DBUS_UNAVAILABLE' })
    },
    async getSecret() {
      throw Object.assign(new Error('service unavailable'), { code: 'DBUS_UNAVAILABLE' })
    },
    async deleteCredential() {
      throw Object.assign(new Error('service unavailable'), { code: 'DBUS_UNAVAILABLE' })
    },
  })
  const credentials = new LinuxSecretServiceCredentialStore(unavailableFactory)
  assert.equal(await credentials.available(), false)
  await assert.rejects(
    () => credentials.resolve(credentialRef('cred:v1:unavailable-native')),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'CREDENTIAL_STORE_UNAVAILABLE',
  )
})

test('native credential availability proves write, read, match, and cleanup', async () => {
  for (const failure of ['write', 'read', 'mismatch', 'delete'] as const) {
    let deleted = 0
    const credentials = new LinuxSecretServiceCredentialStore(() => {
      let stored: Uint8Array | undefined
      return {
        async setSecret(secret) {
          if (failure === 'write') throw new Error('write unavailable')
          stored = Uint8Array.from(secret)
        },
        async getSecret() {
          if (failure === 'read') throw new Error('read unavailable')
          if (failure === 'mismatch') return new Uint8Array(32)
          return stored === undefined ? undefined : Uint8Array.from(stored)
        },
        async deleteCredential() {
          deleted += 1
          stored?.fill(0)
          stored = undefined
          if (failure === 'delete') throw new Error('delete unavailable')
          return failure !== 'write'
        },
      }
    })
    assert.equal(await credentials.available(), false, failure)
    assert.equal(deleted, 1, `${failure} cleanup`)
  }
})

test('concurrent credential availability probes use isolated accounts', async () => {
  const stored = new Map<string, Uint8Array>()
  const accounts = new Set<string>()
  const credentials = new LinuxSecretServiceCredentialStore((_service, account) => {
    accounts.add(account)
    return {
      async setSecret(secret) {
        stored.set(account, Uint8Array.from(secret))
      },
      async getSecret() {
        const value = stored.get(account)
        return value === undefined ? undefined : Uint8Array.from(value)
      },
      async deleteCredential() {
        return stored.delete(account)
      },
    }
  })

  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => credentials.available())), [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ])
  assert.equal(accounts.size, 8)
  assert.equal(stored.size, 0)
})

test('production composition fails closed when the credential facility is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'braid-credentials-unavailable-'))
  const credentials = new MemoryCredentialStore()
  credentials.setAvailable(false)
  await assert.rejects(
    () =>
      openSqliteStorage({
        path: join(root, 'braid.sqlite'),
        workspaceRoot: root,
        credentialStore: credentials,
        databaseKeyRef: credentialRef('cred:v1:unavailable-test'),
      }),
    (error: unknown) =>
      error instanceof StorageError && error.code === 'CREDENTIAL_STORE_UNAVAILABLE',
  )
})

test('secret-designated interaction values are rejected before journal persistence', () => {
  assert.throws(
    () => assertPersistablePayload({ containsSecret: true, value: 'never persist this' }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'StorageError' &&
      /secret-designated/iu.test(error.message),
  )
  assert.throws(
    () => assertPersistablePayload({ password: 'never persist this' }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'StorageError' &&
      error.message.includes('Secret-bearing'),
  )
  assert.doesNotThrow(() =>
    assertPersistablePayload({
      credentialRef: 'cred:v1:opaque-reference',
      credentialKind: 'keychain',
    }),
  )
  const canary = 'SECRET_TYPED_INTERACTION_CANARY'
  assert.throws(
    () =>
      assertPersistablePayload({
        answerSpec: { fields: [{ name: 'credential', type: 'secret' }] },
        value: { credential: canary },
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'StorageError' &&
      /secret-designated/iu.test(error.message),
  )
  assert.throws(
    () =>
      assertPersistablePayload({
        request: {
          answerSpec: { fields: [{ name: 'credential', type: 'secret' }] },
          response: { credential: canary },
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'StorageError' &&
      /secret-designated/iu.test(error.message),
  )
})

test('backup and restore enforce the approved root, descriptor identity, and no-clobber publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-storage-paths-'))
  const storage = await openSqliteStorage({
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    databaseKeyRef: credentialRef('cred:v1:storage-paths-test'),
  })
  const backupPath = join(root, 'backup.sqlite')
  await storage.backup({
    path: backupPath,
    operation: {
      operationId: 'op-path-backup-first',
      kind: 'backup',
      request: { path: backupPath },
      requestDigest: canonicalDigest({ path: backupPath }),
    },
  })
  const destination = join(root, 'no-clobber.sqlite')
  const sentinel = Buffer.from('do not replace')
  await writeFile(destination, sentinel, { mode: 0o600 })
  await assert.rejects(
    () =>
      storage.backup({
        path: destination,
        operation: {
          operationId: 'op-path-backup-second',
          kind: 'backup',
          request: { path: destination },
          requestDigest: canonicalDigest({ path: destination }),
        },
      }),
    (error: unknown) => error instanceof StorageError && error.code === 'BACKUP_EXISTS',
  )
  assert.deepEqual(await readFile(destination), sentinel)
  await assert.rejects(
    () =>
      storage.backup({
        path: join(root, '..', 'outside-braid-backup.sqlite'),
        operation: {
          operationId: 'op-path-backup-outside',
          kind: 'backup',
          request: { path: join(root, '..', 'outside-braid-backup.sqlite') },
          requestDigest: canonicalDigest({
            path: join(root, '..', 'outside-braid-backup.sqlite'),
          }),
        },
      }),
    (error: unknown) => error instanceof StorageError && error.code === 'STORAGE_APPROVED_ROOT',
  )
  const hardLink = join(root, 'backup-hard-link.sqlite')
  await link(backupPath, hardLink)
  await assert.rejects(
    () =>
      storage.restore({
        path: hardLink,
        operation: {
          operationId: 'op-path-restore-hard-link',
          kind: 'restore',
          request: { path: hardLink },
          requestDigest: canonicalDigest({ path: hardLink }),
        },
      }),
    (error: unknown) => error instanceof StorageError && error.code === 'STORAGE_INPUT_IDENTITY',
  )
  await storage.close()
})
