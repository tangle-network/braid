import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { toJsonValue, type JsonValue } from './serialization.js'
import {
  type BraidStateKeyPort,
  type BraidStatePort,
  type BraidStateSnapshot,
  StateConflictError,
} from './state-port.js'

class StateSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StateSecurityError'
  }
}

interface Envelope {
  readonly schemaVersion: number
  readonly revision: number
  readonly nonce: string
  readonly tag: string
  readonly ciphertext: string
}

interface Payload {
  readonly schemaVersion: number
  readonly state: JsonValue
}

export interface EncryptedBraidStatePortOptions<T> {
  readonly schemaVersion?: number
  readonly migrate?: (schemaVersion: number, state: unknown) => BraidStateSnapshot<T>
}

/** Encrypted, crash-recoverable state with explicit revision conflicts. */
export class EncryptedBraidStatePort<T> implements BraidStatePort<T> {
  readonly #path: string
  readonly #backup: string
  readonly #temporary: string
  readonly #lock: string
  readonly #key: BraidStateKeyPort
  readonly #schemaVersion: number
  readonly #migrate: EncryptedBraidStatePortOptions<T>['migrate']

  constructor(
    path: string,
    key: BraidStateKeyPort,
    options: EncryptedBraidStatePortOptions<T> = {},
  ) {
    if (!path) throw new TypeError('Encrypted Braid state needs an explicit path')
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (!name || name === '.' || name === '..')
      throw new TypeError('Encrypted Braid state needs a regular file path')
    this.#path = path
    this.#backup = `${path}.previous`
    this.#temporary = `${path}.tmp`
    this.#lock = `${path}.lock`
    this.#key = key
    this.#schemaVersion = options.schemaVersion ?? 1
    this.#migrate = options.migrate
  }

  async read(): Promise<BraidStateSnapshot<T> | null> {
    return this.#readUnlocked()
  }

  async commit(expectedRevision: number, state: T): Promise<BraidStateSnapshot<T>> {
    return this.#withLock(async () => {
      const current = await this.#readUnlocked()
      const actual = current?.revision ?? 0
      if (actual !== expectedRevision)
        throw new StateConflictError(`Expected revision ${expectedRevision}, found ${actual}`)
      const next = { schemaVersion: this.#schemaVersion, revision: actual + 1, state }
      await this.#write(next)
      return next
    })
  }

  async #readUnlocked(): Promise<BraidStateSnapshot<T> | null> {
    let found = false
    let lastError: unknown
    const valid: BraidStateSnapshot<T>[] = []
    let directory: FileHandle | undefined
    try {
      directory = await this.#openDirectory(false)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (!directory) return null
    try {
      for (const name of [
        this.#name(this.#path),
        this.#name(this.#temporary),
        this.#name(this.#backup),
      ]) {
        const candidate = this.#relativePath(directory, name)
        try {
          const stat = await lstat(candidate)
          found = true
          if (stat.isSymbolicLink() || !stat.isFile())
            throw new StateSecurityError(`Refusing symlinked Braid state: ${name}`)
          const envelope = JSON.parse(await this.#readPrivateText(candidate)) as Envelope
          const payload = await this.#decrypt(envelope)
          if (payload.schemaVersion === this.#schemaVersion) {
            valid.push({
              schemaVersion: payload.schemaVersion,
              revision: envelope.revision,
              state: payload.state as T,
            })
            continue
          }
          if (this.#migrate) {
            const migrated = this.#migrate(payload.schemaVersion, payload.state)
            if (migrated.schemaVersion !== this.#schemaVersion)
              throw new Error('Braid state migration returned the wrong schema version')
            valid.push({
              schemaVersion: migrated.schemaVersion,
              revision: envelope.revision,
              state: migrated.state,
            })
            continue
          }
          throw new Error(`Unsupported Braid state schema version: ${payload.schemaVersion}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          if (error instanceof StateSecurityError) throw error
          lastError = error
        }
      }
    } finally {
      await directory.close()
    }
    if (!found) return null
    if (valid.length > 0)
      return valid.reduce((highest, candidate) =>
        candidate.revision > highest.revision ? candidate : highest,
      )
    throw lastError instanceof Error
      ? lastError
      : new Error('No valid encrypted Braid state copy exists')
  }

  async #decrypt(envelope: Envelope): Promise<Payload> {
    if (
      !envelope ||
      !Number.isSafeInteger(envelope.schemaVersion) ||
      envelope.schemaVersion < 1 ||
      envelope.schemaVersion > this.#schemaVersion ||
      !Number.isSafeInteger(envelope.revision) ||
      envelope.revision < 1
    )
      throw new Error('Invalid encrypted Braid state envelope')
    const key = Buffer.from(await this.#key.resolve())
    if (key.length !== 32) throw new Error('Braid state key must be 32 bytes')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'))
    decipher.setAAD(authenticatedEnvelopeData(envelope.schemaVersion, envelope.revision))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const clear = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ])
    const payload = JSON.parse(clear.toString('utf8')) as Payload
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Number.isSafeInteger(payload.schemaVersion) ||
      payload.schemaVersion < 1 ||
      payload.schemaVersion > this.#schemaVersion ||
      payload.schemaVersion !== envelope.schemaVersion
    )
      throw new Error('Invalid encrypted Braid state payload')
    return payload
  }

  async #readPrivateText(path: string): Promise<string> {
    let file: FileHandle | undefined
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await file.stat()
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new StateSecurityError(`Braid state is not a private regular file: ${path}`)
      if ((stat.mode & 0o077) !== 0)
        throw new StateSecurityError(`Braid state is accessible by another user: ${path}`)
      return await file.readFile('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP')
        throw new StateSecurityError(`Refusing symlinked Braid state: ${path}`)
      throw error
    } finally {
      await file?.close()
    }
  }

  async #write(snapshot: BraidStateSnapshot<T>): Promise<void> {
    const directoryHandle = await this.#openDirectory(true)
    if (!directoryHandle) throw new StateSecurityError('Braid state directory is unavailable')
    const temporary = this.#relativePath(directoryHandle, this.#name(this.#temporary))
    const current = this.#relativePath(directoryHandle, this.#name(this.#path))
    const backup = this.#relativePath(directoryHandle, this.#name(this.#backup))
    try {
      await rm(temporary, { force: true })
      const key = Buffer.from(await this.#key.resolve())
      if (key.length !== 32) throw new Error('Braid state key must be 32 bytes')
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(authenticatedEnvelopeData(snapshot.schemaVersion, snapshot.revision))
      const payload: Payload = {
        schemaVersion: snapshot.schemaVersion,
        state: toJsonValue(snapshot.state) as JsonValue,
      }
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(payload), 'utf8'),
        cipher.final(),
      ])
      const envelope: Envelope = {
        schemaVersion: snapshot.schemaVersion,
        revision: snapshot.revision,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }
      let file: FileHandle | undefined
      try {
        file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        await file.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8')
        await file.sync()
      } finally {
        await file?.close()
      }
      try {
        const currentStat = await lstat(current)
        if (currentStat.isSymbolicLink() || !currentStat.isFile())
          throw new Error(`Refusing symlinked Braid state: ${this.#name(this.#path)}`)
        await rename(current, backup)
        await this.#syncFile(backup)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(temporary, current)
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  }

  #name(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1)
  }

  #relativePath(directory: FileHandle, name: string): string {
    return `/proc/self/fd/${directory.fd}/${name}`
  }

  async #openDirectory(create: boolean): Promise<FileHandle | undefined> {
    const directory = dirname(this.#path)
    if (directory === '/')
      throw new StateSecurityError('Encrypted Braid state needs a private directory')
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      const stat = await handle.stat()
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) await handle.chmod(0o700)
      const privateStat = await handle.stat()
      if ((privateStat.mode & 0o077) !== 0)
        throw new StateSecurityError(
          `Braid state directory is accessible by another user: ${directory}`,
        )
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async #syncFile(path: string): Promise<void> {
    let file: FileHandle | undefined
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      if (!(await file.stat()).isFile())
        throw new StateSecurityError(`Braid state is not a regular file: ${path}`)
      await file.sync()
    } finally {
      await file?.close()
    }
  }

  async #withLock<R>(fn: () => Promise<R>): Promise<R> {
    const directory = await this.#openDirectory(true)
    if (!directory) throw new StateSecurityError('Braid state directory is unavailable')
    const lockPath = this.#relativePath(directory, this.#name(this.#lock))
    let lock: FileHandle | undefined
    try {
      try {
        lock = await open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const owner = JSON.parse(await this.#readPrivateText(lockPath)) as { pid?: unknown }
          if (typeof owner.pid === 'number') {
            try {
              process.kill(owner.pid, 0)
              throw new StateConflictError()
            } catch (probeError) {
              if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError
            }
          }
          await rm(lockPath, { force: true })
          lock = await open(
            lockPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          )
        } catch (probeError) {
          if (probeError instanceof StateConflictError) throw probeError
          throw new StateConflictError('Braid state lock is held by another process')
        }
      }
      if (!lock) throw new StateConflictError('Braid state lock could not be acquired')
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
        await lock.sync()
        return await fn()
      } finally {
        await lock.close()
        await rm(lockPath, { force: true })
      }
    } finally {
      await directory.close()
    }
  }
}

function authenticatedEnvelopeData(schemaVersion: number, revision: number): Buffer {
  return Buffer.from(`braid-state:${schemaVersion}:${revision}`, 'utf8')
}
