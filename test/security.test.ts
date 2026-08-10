import assert from 'node:assert/strict'
import { closeSync, constants, lstatSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
// @ts-expect-error The scanner is a JavaScript release helper without a product declaration.
import { assertNoSecretArtifacts, scanSecretArtifacts } from '../scripts/scan-secret-artifacts.mjs'
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
import {
  acquirePrivateFileLock,
  assertNoSymlinkPath,
  assertSafeDirectory,
  ensurePrivateDirectory,
  ensurePrivateFile,
  fsyncDirectory,
  readNoFollow,
  releasePrivateFileLock,
  replacePrivateFile,
  SafeFileError,
  writePrivateFile,
} from '../src/adapters/persistence/safe-file.js'
import { componentPath, safePath } from '../src/adapters/persistence/safe-file-descriptor.js'
import { openSqliteStorage } from '../src/adapters/storage/sqlite.js'
import { assertPersistablePayload } from '../src/adapters/storage/sqlite-crypto.js'
import { StorageError } from '../src/adapters/storage/sqlite-errors.js'
import { prepareConversationImport } from '../src/app/conversation-import-document.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import { TerminalControlSanitizer } from '../src/domain/terminal-sanitizer.js'
import { credentialRef } from '../src/ports/credentials.js'

test('terminal control sanitization remains safe when hostile sequences split across chunks', () => {
  const sanitizer = new TerminalControlSanitizer()
  assert.equal(sanitizer.push('before\u001b]0;owned'), 'before')
  assert.equal(sanitizer.push('\u0007after'), 'after')
  assert.equal(
    sanitizer.push(`before\u001bP${'x'.repeat(5_000)}visible`),
    `before${'x'.repeat(905)}visible`,
  )
  assert.equal(sanitizer.finish(), '')
})

test('generated artifact secret scanning catches leaks, accepts redacted output, and rejects links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-secret-artifacts-'))
  const canary = 'W12_SECRET_ARTIFACT_CANARY'
  try {
    await writeFile(join(root, 'safe.log'), 'redacted credential output\n')
    await assertNoSecretArtifacts(root, [canary])
    await writeFile(join(root, 'leak.log'), `unexpected ${canary}\n`)
    assert.deepEqual(await scanSecretArtifacts(root, [canary]), [
      { path: 'leak.log', canaryBytes: Buffer.byteLength(canary) },
    ])
    await assert.rejects(() => assertNoSecretArtifacts(root, [canary]), /Secret canary found/u)
    await rm(join(root, 'leak.log'))
    await symlink(join(root, 'safe.log'), join(root, 'linked.log'))
    await assert.rejects(() => scanSecretArtifacts(root, [canary]), /refuses symlink/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('private artifact writes are mode-600, no-clobber, and symlink-safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-private-artifact-'))
  try {
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      assert.throws(
        () => writePrivateFile(join(root, 'state.json'), 'unsupported'),
        (error: unknown) =>
          error instanceof SafeFileError && error.code === 'SAFE_FILE_PATH_RACE_UNSUPPORTED',
      )
      return
    }
    const target = join(root, 'state.json')
    writePrivateFile(target, 'first')
    assert.equal((await readFile(target)).toString(), 'first')
    assert.equal((await stat(target)).mode & 0o777, 0o600)
    assert.throws(() => writePrivateFile(target, 'second'), /EEXIST|exist/u)
    assert.equal((await readFile(target)).toString(), 'first')
    const victim = join(root, 'victim.json')
    const linkPath = join(root, 'link.json')
    await writeFile(victim, 'unchanged')
    await symlink(victim, linkPath)
    assert.throws(() => writePrivateFile(linkPath, 'overwrite'), /symbolic|EEXIST|exist/u)
    assert.throws(
      () => readNoFollow(linkPath, 128),
      (error: unknown) => error instanceof SafeFileError && error.code === 'SAFE_FILE_SYMLINK',
    )
    assert.equal((await readFile(victim)).toString(), 'unchanged')

    const directory = join(root, 'directory')
    await mkdir(directory)
    assert.throws(
      () => readNoFollow(directory, 128),
      (error: unknown) => error instanceof SafeFileError && error.code === 'SAFE_FILE_NOT_REGULAR',
    )
    assert.throws(
      () => writePrivateFile(directory, 'not a directory replacement'),
      (error: unknown) => error instanceof SafeFileError && error.code === 'SAFE_FILE_NOT_REGULAR',
    )

    const permissionsTarget = join(root, 'permissions.json')
    writePrivateFile(permissionsTarget, 'repair permissions')
    await chmod(permissionsTarget, 0o644)
    ensurePrivateFile(permissionsTarget)
    assert.equal((await stat(permissionsTarget)).mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('safe component paths preserve anchors and round-trip across supported platforms', () => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    assert.throws(
      () => safePath(join(tmpdir(), 'braid-safe-path', 'parent', 'leaf')),
      (error: unknown) =>
        error instanceof SafeFileError && error.code === 'SAFE_FILE_PATH_RACE_UNSUPPORTED',
    )
    return
  }
  if (sep === '/') {
    assert.equal(
      componentPath({ absolute: '/tmp/parent', root: '/', components: ['tmp', 'parent'] }, 2),
      '/tmp/parent',
    )
  }
  const parsed = safePath(join(tmpdir(), 'braid-safe-path', 'parent', 'leaf'))
  assert.equal(componentPath(parsed, parsed.components.length), parsed.absolute)
  assert.equal(componentPath(parsed, 0), parsed.root)
})

const PARENT_SWAP_WORKER = `
  const { parentPort, workerData } = require('node:worker_threads')
  const { renameSync, rmSync, symlinkSync } = require('node:fs')
  const replaceCollisions = new Set(['EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY'])
  const clearActive = () => {
    for (;;) {
      try {
        rmSync(workerData.active, { recursive: true, force: true, maxRetries: 10 })
        return
      } catch (error) {
        if (!replaceCollisions.has(error.code)) throw error
      }
    }
  }
  let checksum = 0
  parentPort.postMessage('ready')
  parentPort.once('message', (message) => {
    if (message !== 'start') return
    for (let index = 0; index < workerData.iterations; index += 1) {
      renameSync(workerData.active, workerData.parked)
      for (;;) {
        try {
          symlinkSync(workerData.evil, workerData.active)
          break
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          clearActive()
        }
      }
      for (let spin = 0; spin < 512; spin += 1) checksum = (checksum + spin) & 0xffff
      clearActive()
      for (;;) {
        try {
          renameSync(workerData.parked, workerData.active)
          break
        } catch (error) {
          if (!replaceCollisions.has(error.code)) throw error
          clearActive()
        }
      }
    }
    if (checksum === -1) throw new Error('unreachable')
    parentPort.postMessage('done')
  })
`

function legacyReadNoFollow(path: string): Buffer | undefined {
  const absolute = resolve(path)
  const parsed = parse(absolute)
  let current = parsed.root
  try {
    for (const component of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
      current = join(current, component)
      if (lstatSync(current).isSymbolicLink()) {
        const error = new Error(`legacy symlink: ${absolute}`) as NodeJS.ErrnoException
        error.code = 'ELOOP'
        throw error
      }
    }
    const handle = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return readFileSync(handle)
    } finally {
      closeSync(handle)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function workerMessage(worker: Worker, expected: string): Promise<void> {
  return new Promise((resolveMessage, reject) => {
    const onError = (error: Error) => {
      worker.off('message', onMessage)
      reject(error)
    }
    const onMessage = (message: unknown) => {
      if (message !== expected) return
      worker.off('error', onError)
      resolveMessage()
    }
    worker.once('error', onError)
    worker.on('message', onMessage)
  })
}

interface ParentSwapRaceResult {
  readonly attempts: number
  readonly safeReads: number
  readonly evilReads: number
  readonly rejected: number
}

interface ParentSwapRacePaths {
  readonly active: string
  readonly parked: string
  readonly evil: string
  readonly source: string
}

const EXPECTED_PARENT_SWAP_REJECTIONS = new Set([
  'EEXIST',
  'EISDIR',
  'ELOOP',
  'ENOENT',
  'ENOTDIR',
  'SAFE_FILE_NOT_DIRECTORY',
  'SAFE_FILE_NOT_REGULAR',
  'SAFE_FILE_PUBLISHED_INVALID',
  'SAFE_FILE_SYMLINK',
])

async function runParentSwapRace(
  root: string,
  label: string,
  read: (path: string, paths: ParentSwapRacePaths) => 'safe' | 'evil',
  iterations = 50_000,
  prepare?: (paths: ParentSwapRacePaths) => Promise<void>,
): Promise<ParentSwapRaceResult> {
  const active = join(root, `${label}-active`)
  const parked = join(root, `${label}-parked`)
  const evil = join(root, `${label}-evil`)
  const relativeSource = join('one', 'two', 'three', 'conversation.json')
  const activeSource = join(active, relativeSource)
  const evilSource = join(evil, relativeSource)
  await mkdir(join(active, 'one', 'two', 'three'), { recursive: true })
  await mkdir(join(evil, 'one', 'two', 'three'), { recursive: true })
  await writeFile(activeSource, conversationFixture('safe'))
  await writeFile(evilSource, conversationFixture('evil'))
  const paths = { active, parked, evil, source: activeSource }
  await prepare?.(paths)

  const worker = new Worker(PARENT_SWAP_WORKER, {
    eval: true,
    workerData: { active, parked, evil, iterations },
  })
  let safeReads = 0
  let evilReads = 0
  let rejected = 0
  try {
    await workerMessage(worker, 'ready')
    worker.postMessage('start')
    for (let attempt = 0; attempt < iterations; attempt += 1) {
      try {
        const result = read(activeSource, paths)
        if (result === 'evil') evilReads += 1
        else safeReads += 1
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (
          code === 'ENOENT' ||
          code === 'ELOOP' ||
          code === 'SAFE_FILE_SYMLINK' ||
          code === 'IMPORT_NOT_FOUND' ||
          code === 'IMPORT_SOURCE_UNSAFE'
        ) {
          rejected += 1
          continue
        }
        throw error
      }
    }
    await workerMessage(worker, 'done')
  } finally {
    await worker.terminate()
    await rm(parked, { recursive: true, force: true })
  }
  return { attempts: iterations, safeReads, evilReads, rejected }
}

function conversationFixture(conversationId: 'safe' | 'evil'): string {
  const content = {
    conversation: { id: `conversation-${conversationId}` },
    branches: [],
    messages: [],
    messageParts: [],
    turns: [],
    runs: [],
    analyses: [],
    graphNodes: [],
    graphEdges: [],
    feedbackDecisions: [],
  }
  return JSON.stringify({
    schemaVersion: 2,
    format: 'braid-conversation',
    exportedAt: '2026-08-03T00:00:00.000Z',
    conversationId,
    content,
    contentDigest: canonicalDigest(content),
    redacted: true,
    externalControlsDisabled: true,
  })
}

test('parent directory swaps cannot make conversation import read the evil tree', {
  timeout: 120_000,
}, async (t) => {
  if (process.platform !== 'linux') return
  const root = await mkdtemp(join(tmpdir(), 'braid-parent-race-'))
  try {
    const legacy = await runParentSwapRace(root, 'legacy', (path) => {
      const bytes = legacyReadNoFollow(path)
      if (bytes === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return bytes.includes(Buffer.from('"conversationId":"evil"')) ? 'evil' : 'safe'
    })
    const fixed = await runParentSwapRace(root, 'fixed', (path) =>
      prepareConversationImport({ source: path }).document.conversationId === 'evil'
        ? 'evil'
        : 'safe',
    )
    t.diagnostic(`legacy evilReads:${legacy.evilReads}/${legacy.attempts}`)
    t.diagnostic(`fixed evilReads:${fixed.evilReads}/${fixed.attempts}`)
    assert.ok(legacy.evilReads > 0, JSON.stringify(legacy))
    assert.equal(fixed.evilReads, 0, JSON.stringify(fixed))
    assert.equal(fixed.attempts, fixed.safeReads + fixed.rejected)

    const evilHelperDirectory = join(root, 'helpers-evil', 'one', 'two', 'three')
    const helperRace = await runParentSwapRace(
      root,
      'helpers',
      (_path, paths) => {
        const nested = join(paths.active, 'one', 'two', 'three')
        const operations: readonly (() => unknown)[] = [
          () => assertNoSymlinkPath(join(nested, 'conversation.json')),
          () => readNoFollow(join(nested, 'conversation.json'), 2_048),
          () => ensurePrivateFile(join(nested, 'mode.txt')),
          () => assertSafeDirectory(nested),
          () => fsyncDirectory(nested),
          () => ensurePrivateDirectory(join(nested, 'created')),
          () => writePrivateFile(join(nested, 'write.txt'), 'safe write'),
          () =>
            replacePrivateFile(join(nested, 'replace.txt'), 'safe replace', { overwrite: true }),
          () => {
            const handle = acquirePrivateFileLock(join(nested, 'journal.lock'))
            releasePrivateFileLock(join(nested, 'journal.lock'), handle)
          },
        ]
        for (const operation of operations) {
          try {
            operation()
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === undefined || !EXPECTED_PARENT_SWAP_REJECTIONS.has(code)) {
              throw error
            }
          }
        }
        return 'safe'
      },
      200,
      async (paths) => {
        const nested = join(paths.active, 'one', 'two', 'three')
        const evilNested = join(paths.evil, 'one', 'two', 'three')
        await writeFile(join(nested, 'mode.txt'), 'safe mode')
        await writeFile(join(nested, 'replace.txt'), 'safe replace baseline')
        await writeFile(join(evilNested, 'mode.txt'), 'evil mode')
        await writeFile(join(evilNested, 'replace.txt'), 'evil replace baseline')
        await chmod(join(evilNested, 'mode.txt'), 0o644)
      },
    )
    t.diagnostic(`fixed helper operations:${helperRace.attempts}`)
    assert.equal(
      await readFile(join(evilHelperDirectory, 'conversation.json'), 'utf8').then((value) =>
        value.includes('"conversationId":"evil"'),
      ),
      true,
    )
    assert.equal(
      await readFile(join(evilHelperDirectory, 'replace.txt'), 'utf8'),
      'evil replace baseline',
    )
    assert.equal((await stat(join(evilHelperDirectory, 'mode.txt'))).mode & 0o777, 0o644)
    await assert.rejects(() => stat(join(evilHelperDirectory, 'created')), { code: 'ENOENT' })
    await assert.rejects(() => stat(join(evilHelperDirectory, 'write.txt')), { code: 'ENOENT' })
    await assert.rejects(() => stat(join(evilHelperDirectory, 'journal.lock')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('every safe-file operation rejects a swapped parent and unsupported platforms explain refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-safe-file-parent-'))
  try {
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      assert.throws(
        () => readNoFollow(join(root, 'missing'), 128),
        (error: unknown) =>
          error instanceof SafeFileError && error.code === 'SAFE_FILE_PATH_RACE_UNSUPPORTED',
      )
      return
    }
    const active = join(root, 'active')
    const parked = join(root, 'parked')
    const evil = join(root, 'evil')
    await mkdir(join(active, 'nested'), { recursive: true })
    await mkdir(evil, { recursive: true })
    await writeFile(join(active, 'nested', 'read.txt'), 'safe')
    await writeFile(join(evil, 'read.txt'), 'evil')
    await rename(active, parked)
    await symlink(evil, active)

    const checks: readonly [string, () => unknown][] = [
      ['assertNoSymlinkPath', () => assertNoSymlinkPath(join(active, 'nested', 'read.txt'))],
      ['readNoFollow', () => readNoFollow(join(active, 'nested', 'read.txt'), 128)],
      ['ensurePrivateFile', () => ensurePrivateFile(join(active, 'nested', 'read.txt'))],
      ['assertSafeDirectory', () => assertSafeDirectory(active)],
      ['fsyncDirectory', () => fsyncDirectory(active)],
      ['ensurePrivateDirectory', () => ensurePrivateDirectory(join(active, 'new'))],
      ['writePrivateFile', () => writePrivateFile(join(active, 'write.txt'), 'blocked')],
      [
        'replacePrivateFile',
        () => replacePrivateFile(join(active, 'replace.txt'), 'blocked', { overwrite: true }),
      ],
      ['acquirePrivateFileLock', () => acquirePrivateFileLock(join(active, 'journal.lock'))],
    ]
    for (const [name, operation] of checks) {
      assert.throws(
        operation,
        (error: unknown) => error instanceof SafeFileError && error.code === 'SAFE_FILE_SYMLINK',
        name,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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

test('native credential removal rejects a false deletion result while the secret remains', async () => {
  let stored = Uint8Array.from(Buffer.alloc(32, 23))
  const credentials = new LinuxSecretServiceCredentialStore(() => ({
    async setSecret(secret) {
      stored = Uint8Array.from(secret)
    },
    async getSecret() {
      return stored.length === 0 ? undefined : Uint8Array.from(stored)
    },
    async deleteCredential() {
      return false
    },
  }))
  const ref = credentialRef('cred:v1:false-native-delete')
  await assert.rejects(
    credentials.remove(ref),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'CREDENTIAL_REMOVE_FAILED',
  )
  assert.equal(stored.length, 32)
  stored.fill(0)
  stored = new Uint8Array()
  await credentials.remove(ref)
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
  assert.doesNotThrow(() =>
    assertPersistablePayload({ inputTokens: 12, outputTokens: 7, reasoningTokens: 3 }),
  )
  assert.doesNotThrow(() => assertPersistablePayload({ tokensKnown: false }))
  assert.throws(
    () => assertPersistablePayload({ tokensKnown: 'false' }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'StorageError' &&
      error.message.includes('Secret-bearing'),
  )
  assert.throws(
    () => assertPersistablePayload({ token: true }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'StorageError' &&
      error.message.includes('Secret-bearing'),
  )
  assert.doesNotThrow(() =>
    assertPersistablePayload({ spend: { tokens: { input: 12, output: 7 } } }),
  )
  assert.throws(
    () => assertPersistablePayload({ tokens: { input: 12, output: 7, credential: 'canary' } }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'StorageError' &&
      error.message.includes('Secret-bearing'),
  )
  assert.throws(
    () => assertPersistablePayload({ inputTokens: 'never persist this' }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'StorageError' &&
      error.message.includes('Secret-bearing'),
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
