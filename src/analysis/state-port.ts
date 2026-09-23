export interface BraidStateKeyPort {
  resolve(): Promise<Uint8Array>
}

export class MemoryStateKeyPort implements BraidStateKeyPort {
  private readonly key: Uint8Array

  constructor(key: Uint8Array) {
    this.key = new Uint8Array(key)
  }

  async resolve(): Promise<Uint8Array> {
    return new Uint8Array(this.key)
  }
}

export class EnvironmentStateKeyPort implements BraidStateKeyPort {
  constructor(private readonly variable = 'BRAID_STATE_KEY') {}

  async resolve(): Promise<Uint8Array> {
    const value = process.env[this.variable]
    if (!value) throw new Error(`${this.variable} is required for encrypted Braid state`)
    const key = Buffer.from(value, 'base64')
    if (key.length !== 32) throw new Error(`${this.variable} must contain a 32-byte base64 key`)
    return new Uint8Array(key)
  }
}

export interface BraidStateSnapshot<T> {
  readonly schemaVersion: number
  readonly revision: number
  readonly state: T
}

export interface BraidStatePort<T> {
  read(): Promise<BraidStateSnapshot<T> | null>
  commit(expectedRevision: number, state: T): Promise<BraidStateSnapshot<T>>
}

export class StateConflictError extends Error {
  constructor(message = 'Braid state changed in another process') {
    super(message)
    this.name = 'StateConflictError'
  }
}
