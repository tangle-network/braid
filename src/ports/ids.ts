import { randomUUID } from 'node:crypto'

export type IdKind = 'message' | 'run' | 'turn' | 'operation' | 'receipt' | 'shutdown'

export interface IdSource {
  next(kind: IdKind): string
}

export class RandomIds implements IdSource {
  next(kind: IdKind): string {
    return `${kind}-${randomUUID()}`
  }
}

export class SequenceIds implements IdSource {
  #value = 0

  next(kind: IdKind): string {
    this.#value += 1
    return `${kind}-${String(this.#value).padStart(6, '0')}`
  }
}
