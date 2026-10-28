import { createHash } from 'node:crypto'
import { closeSync, constants } from 'node:fs'
import { openLeaf, openParent, requireRegularFile } from '../persistence/safe-file-descriptor.js'
import { tryLock } from '../persistence/posix-at.js'

/** Per-state run observers and short journal transitions use descriptor-held kernel locks. */
export class RunOwnership {
  readonly #locks = new Map<string, number>()
  constructor(readonly statePath: string) {}
  owns = (runId: string): boolean => this.#locks.has(runId)
  claim = (runId: string): boolean => {
    if (this.owns(runId)) return true
    const fd = this.#acquire(`run-${createHash('sha256').update(runId).digest('hex')}`)
    if (fd === undefined) return false
    this.#locks.set(runId, fd)
    return true
  }
  async transition<T>(action: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 30_000
    let fd = this.#acquire('transition')
    while (fd === undefined) {
      if (Date.now() >= deadline) throw new Error('State journal is busy in another Braid process')
      await new Promise((resolve) => setTimeout(resolve, 10))
      fd = this.#acquire('transition')
    }
    try {
      return await action()
    } finally {
      closeSync(fd)
    }
  }
  release = (runId: string): void => {
    const fd = this.#locks.get(runId)
    if (fd === undefined) return
    this.#locks.delete(runId)
    closeSync(fd)
  }
  close(): void {
    for (const runId of this.#locks.keys()) this.release(runId)
  }
  #acquire(key: string): number | undefined {
    const parent = openParent(`${this.statePath}.${key}.lock`)
    let fd: number | undefined
    try {
      fd = openLeaf(
        parent,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      )
      requireRegularFile(fd, parent.leafPath)
      if (tryLock(fd)) return fd
      closeSync(fd)
      return undefined
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      throw error
    } finally {
      closeSync(parent.fd)
    }
  }
}
