import type { ConnectionRecord } from '../domain/entities.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { ActionHost } from './action-host.js'
import {
  acknowledgedConnectionOperation,
  cachedCapabilities,
  connectionSelectionOperationResult,
  connectionSummary,
  connectionTestOperationResult,
  operationSelectionSummary,
  operationTestResult,
  pendingConnectionOperation,
  selectedModel,
  unverifiedModel,
} from './connection-action-support.js'
import type {
  ConnectionListResult,
  ConnectionSelectionResult,
  ConnectionTestResult,
  ConnectionTestResultData,
} from './connection-action-types.js'
import type { ConnectionProbeFactory } from './connection-probe.js'
import { ConnectionRegistry } from './connections.js'
import { operationReplay, parseOperation, requestDigest } from './conversation-support.js'
import { AppError } from './errors.js'

export type {
  ConnectionListResult,
  ConnectionSelectionResult,
  ConnectionSummary,
  ConnectionTestResult,
  ConnectionTestResultData,
} from './connection-action-types.js'

export interface ConnectionActionOptions {
  readonly host: ActionHost
  readonly connections?: readonly ConnectionRecord[]
  readonly probeFor?: ConnectionProbeFactory
  readonly now?: () => string
}

export class ConnectionActionService {
  readonly #options: ConnectionActionOptions

  constructor(options: ConnectionActionOptions) {
    this.#options = options
  }

  async list(query = ''): Promise<ConnectionListResult> {
    const state = this.#options.host.state()
    const model = selectedModel(state.profile)
    const normalized = query.trim().toLowerCase()
    const connections = this.#records()
      .filter((record) => {
        if (!normalized) return true
        return [
          record.id,
          record.name,
          record.kind,
          record.endpoint,
          record.providerOptions.region,
          record.providerOptions.account,
        ]
          .filter((value): value is string => value !== undefined)
          .some((value) => value.toLowerCase().includes(normalized))
      })
      .map((record) => connectionSummary(record, model, cachedCapabilities(state, record.id)))
    return { connections }
  }

  async select(input: {
    readonly operationId: string
    readonly connectionId: string
    readonly expectedRevision?: number
  }): Promise<ConnectionSelectionResult> {
    const operationId = parseOperation(input.operationId, 'select_connection')
    const digest = requestDigest('select_connection', {
      connectionId: input.connectionId,
      expectedRevision: input.expectedRevision ?? null,
    })
    const record = this.#find(input.connectionId)
    const replay = operationReplay(
      this.#options.host.state(),
      operationId,
      'connection-change',
      digest,
    )
    if (replay !== undefined) {
      if (replay.status !== 'acknowledged') throw reconciliationRequired(operationId)
      const summary = operationSelectionSummary(replay, record.credentialRef !== undefined)
      if (summary === undefined) throw reconciliationRequired(operationId)
      this.#options.host.runtime?.syncFromState(this.#options.host.state())
      return {
        connection: summary,
        revision: this.#options.host.state().revision,
        replayed: true,
      }
    }

    const state = this.#options.host.state()
    const summary = connectionSummary(
      record,
      selectedModel(state.profile),
      cachedCapabilities(state, record.id),
    )
    const next = await this.#options.host.configuration.selectConnection({
      connection: record,
      operation: acknowledgedConnectionOperation({
        id: operationId,
        digest,
        at: this.#now(),
        result: {
          ...connectionSelectionOperationResult(record.id, summary),
        },
      }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    })
    this.#options.host.runtime?.setConnection(record.id)
    return { connection: summary, revision: next.revision, replayed: false }
  }

  async test(input: {
    readonly operationId: string
    readonly connectionId: string
  }): Promise<ConnectionTestResult> {
    const operationId = parseOperation(input.operationId, 'test_connection')
    const model = selectedModel(this.#options.host.state().profile)
    const digest = requestDigest('test_connection', {
      connectionId: input.connectionId,
      model: model ?? null,
    })
    const record = this.#find(input.connectionId)
    const replay = operationReplay(
      this.#options.host.state(),
      operationId,
      'connection-change',
      digest,
    )
    if (replay !== undefined) {
      if (replay.status !== 'acknowledged') throw reconciliationRequired(operationId)
      const result = operationTestResult(replay, record.credentialRef !== undefined)
      if (result === undefined) throw reconciliationRequired(operationId)
      return {
        ...result,
        revision: this.#options.host.state().revision,
        replayed: true,
      }
    }

    const probe = this.#options.probeFor?.(record)
    if (probe === undefined) {
      throw new AppError(
        'CONNECTION_ADAPTER_UNAVAILABLE',
        'No production connection probe is configured for this connection',
      )
    }
    const pending = pendingConnectionOperation(operationId, digest, this.#now())
    await this.#options.host.configuration.requestOperation({ operation: pending })
    try {
      const [health, capabilities] = await Promise.all([probe.health(), probe.capabilities()])
      const modelVerification = probe.verifyModel
        ? await probe.verifyModel(model ?? '', { now: () => this.#now() })
        : unverifiedModel(model, this.#now())
      const updated: ConnectionRecord = {
        ...record,
        lastHealth: health,
        lastModelVerification: modelVerification,
        updatedAt: this.#now(),
      }
      const summary = connectionSummary(updated, model, capabilities)
      const result: ConnectionTestResultData = {
        connection: summary,
        health,
        modelVerification,
        capabilities,
        ready: summary.ready,
      }
      const next = await this.#options.host.configuration.updateConnectionHealth({
        connection: updated,
        operation: acknowledgedConnectionOperation({
          id: operationId,
          digest,
          at: this.#now(),
          result: connectionTestOperationResult(result),
        }),
      })
      return { ...result, revision: next.revision, replayed: false }
    } catch (error) {
      await this.#recordFailure(operationId, digest, error)
      throw error
    }
  }

  #records(): readonly ConnectionRecord[] {
    const records = new Map<string, ConnectionRecord>()
    for (const record of this.#options.host.state().connections) records.set(record.id, record)
    for (const record of this.#options.connections ?? []) {
      if (!records.has(record.id)) records.set(record.id, record)
    }
    return new ConnectionRegistry([...records.values()]).list()
  }

  #find(connectionId: string): ConnectionRecord {
    const record = new ConnectionRegistry(this.#records()).get(connectionId)
    if (record === undefined) {
      throw new AppError(
        'CONNECTION_NOT_FOUND',
        `Connection ${redactSensitiveText(connectionId, 512)} was not found`,
      )
    }
    return record
  }

  #now(): string {
    return this.#options.now?.() ?? new Date().toISOString()
  }

  async #recordFailure(
    operationId: ReturnType<typeof parseOperation>,
    digest: ReturnType<typeof requestDigest>,
    error: unknown,
  ): Promise<void> {
    try {
      await this.#options.host.configuration.failOperation({
        id: operationId,
        kind: 'connection-change',
        requestDigest: digest,
        status: 'failed',
        failureCode: errorCode(error),
        failureMessage: redactSensitiveText(errorMessage(error), 2048),
        createdAt: this.#now(),
        updatedAt: this.#now(),
      })
    } catch {
      // Preserve the provider failure as the actionable result.
    }
  }
}

function reconciliationRequired(operationId: string): AppError {
  return new AppError(
    'OPERATION_REQUIRES_RECONCILIATION',
    `Operation ${operationId} needs reconciliation before it can be retried`,
  )
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'CONNECTION_TEST_FAILED'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Connection test failed'
}
