import type {
  AnalysisOperationRecord,
  AnalysisOperationReservation,
  AnalysisRecord,
  AnalysisRepository,
  JsonValue,
} from './model.js'
import { StateConflictError, type BraidStatePort } from './state-port.js'
import {
  commitAnalysisRecord,
  commitUnknownAnalysisRecord,
  completeAnalysisOperation,
  emptyAnalysisState,
  markAnalysisOperationUnknown,
  normalizeAnalysisState,
  renewAnalysisOperation,
  reserveAnalysisOperation,
  saveAnalysisRecord,
  type AnalysisReservationInput,
  type AnalysisStateTransition,
  type AnalysisState,
} from './repository-state.js'
import { cloneJson } from './serialization.js'

export class InMemoryAnalysisRepository implements AnalysisRepository {
  #state = emptyAnalysisState()

  async save(record: AnalysisRecord): Promise<void> {
    this.#state = saveAnalysisRecord(this.#state, record).state
  }

  async commitRecord(
    record: AnalysisRecord,
    requestDigest: string,
    updatedAt: string,
    ownerId?: string,
  ): Promise<boolean> {
    const transition = commitAnalysisRecord(
      this.#state,
      record,
      requestDigest,
      updatedAt,
      ownerId,
    )
    this.#state = transition.state
    return transition.result
  }

  async commitUnknownRecord(
    record: AnalysisRecord,
    requestDigest: string,
    updatedAt: string,
  ): Promise<boolean> {
    const transition = commitUnknownAnalysisRecord(
      this.#state,
      record,
      requestDigest,
      updatedAt,
    )
    this.#state = transition.state
    return transition.result
  }

  async get(analysisId: string): Promise<AnalysisRecord | null> {
    const record = this.#state.records.find((item) => item.analysisId === analysisId)
    return record ? cloneJson(record) : null
  }

  async list(): Promise<readonly AnalysisRecord[]> {
    return this.#state.records.map(cloneJson)
  }

  async reserve(input: AnalysisReservationInput): Promise<AnalysisOperationReservation> {
    const transition = reserveAnalysisOperation(this.#state, input)
    this.#state = transition.state
    return transition.result
  }

  async renew(
    operationId: string,
    requestDigest: string,
    updatedAt: string,
    leaseUntil: string,
    ownerId: string,
  ): Promise<boolean> {
    const transition = renewAnalysisOperation(
      this.#state,
      operationId,
      requestDigest,
      updatedAt,
      leaseUntil,
      ownerId,
    )
    this.#state = transition.state
    return transition.result
  }

  async complete(
    operationId: string,
    requestDigest: string,
    result: JsonValue,
    updatedAt: string,
    ownerId?: string,
  ): Promise<void> {
    this.#state = completeAnalysisOperation(
      this.#state,
      operationId,
      requestDigest,
      result,
      updatedAt,
      ownerId,
    ).state
  }

  async markUnknown(
    operationId: string,
    requestDigest: string,
    updatedAt: string,
    ownerId?: string,
  ): Promise<void> {
    this.#state = markAnalysisOperationUnknown(
      this.#state,
      operationId,
      requestDigest,
      updatedAt,
      ownerId,
    ).state
  }

  async getOperation(operationId: string): Promise<AnalysisOperationRecord | null> {
    const operation = this.#state.operations.find((item) => item.operationId === operationId)
    return operation ? cloneJson(operation) : null
  }
}

/** Analysis persistence through the encrypted Braid state port. */
export class EncryptedAnalysisRepository implements AnalysisRepository {
  static readonly maxUpdateAttempts = 32

  constructor(private readonly state: BraidStatePort<AnalysisState>) {}

  async save(record: AnalysisRecord): Promise<void> {
    await this.update((current) => saveAnalysisRecord(current, record))
  }

  async commitRecord(
    record: AnalysisRecord,
    requestDigest: string,
    updatedAt: string,
    ownerId?: string,
  ): Promise<boolean> {
    return this.update((current) =>
      commitAnalysisRecord(current, record, requestDigest, updatedAt, ownerId),
    )
  }

  async commitUnknownRecord(
    record: AnalysisRecord,
    requestDigest: string,
    updatedAt: string,
  ): Promise<boolean> {
    return this.update((current) =>
      commitUnknownAnalysisRecord(current, record, requestDigest, updatedAt),
    )
  }

  async get(analysisId: string): Promise<AnalysisRecord | null> {
    const record = (await this.read()).records.find((item) => item.analysisId === analysisId)
    return record ? cloneJson(record) : null
  }

  async list(): Promise<readonly AnalysisRecord[]> {
    return (await this.read()).records.map(cloneJson)
  }

  async reserve(input: AnalysisReservationInput): Promise<AnalysisOperationReservation> {
    return this.update((current) => reserveAnalysisOperation(current, input))
  }

  async renew(
    operationId: string,
    requestDigest: string,
    updatedAt: string,
    leaseUntil: string,
    ownerId: string,
  ): Promise<boolean> {
    return this.update((current) =>
      renewAnalysisOperation(current, operationId, requestDigest, updatedAt, leaseUntil, ownerId),
    )
  }

  async complete(
    operationId: string,
    requestDigest: string,
    result: JsonValue,
    updatedAt: string,
    ownerId?: string,
  ): Promise<void> {
    await this.update((current) =>
      completeAnalysisOperation(current, operationId, requestDigest, result, updatedAt, ownerId),
    )
  }

  async markUnknown(
    operationId: string,
    requestDigest: string,
    updatedAt: string,
    ownerId?: string,
  ): Promise<void> {
    await this.update((current) =>
      markAnalysisOperationUnknown(current, operationId, requestDigest, updatedAt, ownerId),
    )
  }

  async getOperation(operationId: string): Promise<AnalysisOperationRecord | null> {
    const operation = (await this.read()).operations.find(
      (item) => item.operationId === operationId,
    )
    return operation ? cloneJson(operation) : null
  }

  private async read(): Promise<AnalysisState> {
    const snapshot = await this.state.read()
    return snapshot ? normalizeAnalysisState(snapshot.state) : emptyAnalysisState()
  }

  private async update<T>(
    fn: (state: AnalysisState) => AnalysisStateTransition<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < EncryptedAnalysisRepository.maxUpdateAttempts; attempt += 1) {
      const snapshot = await this.state.read()
      const current = snapshot ? normalizeAnalysisState(snapshot.state) : emptyAnalysisState()
      const transition = fn(current)
      if (!transition.changed) return transition.result
      try {
        await this.state.commit(snapshot?.revision ?? 0, transition.state)
        return transition.result
      } catch (error) {
        if (
          !(error instanceof StateConflictError) ||
          attempt === EncryptedAnalysisRepository.maxUpdateAttempts - 1
        )
          throw error
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, 5 * (attempt + 1))))
      }
    }
    throw new StateConflictError('Braid state update did not converge')
  }
}

export type { AnalysisState } from './repository-state.js'
