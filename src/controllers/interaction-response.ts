import {
  canonicalInteractionData,
  interactionRequestDigest,
  interactionResponseFingerprint,
  validateInteractionData,
} from '../domain/interaction.js'
import { canonicalDigest } from '../domain/canonical.js'
import {
  interactionKey,
  interactionStatusIsUncertain,
  type InteractionStatus,
  type InteractionRecord,
} from '../domain/interaction-state.js'
import type { Clock } from '../ports/clock.js'
import type {
  CancelInteractionInput,
  InteractionResponseResult,
  InteractionRuntimePort,
  RespondInteractionInput,
} from '../ports/interactions.js'
import type { IdSource } from '../ports/ids.js'
import {
  acceptedCapabilityError,
  bindingMatches,
  responseResult,
} from './interaction-response-policy.js'
import { InteractionError } from './interaction-error.js'
import type { InteractionPersistence } from './interaction-persistence.js'
import type { Scheduler } from '../ports/scheduler.js'
import { reconcilePendingResponse } from './interaction-response-reconciliation.js'
import { tickInteractions } from './interaction-timeout.js'
import { assertResponseInputBounded } from './interaction-input-bounds.js'
import {
  type OperationAuthority,
  OperationConflictError,
  assertOperationId,
  type OperationRecord,
} from '../domain/operation-authority.js'
import { performInteractionResponse } from './interaction-response-effect.js'
import { bindingForRecord } from './interaction-controller-utils.js'

interface StoredResponseOperation {
  readonly key: string
  readonly fingerprint: string
  readonly requestDigest: string
  readonly promise: Promise<InteractionResponseResult>
}

export class InteractionResponse {
  readonly #persistence: InteractionPersistence
  readonly #runtime: InteractionRuntimePort
  readonly #clock: Clock
  readonly #ids: IdSource
  readonly #automationRuleFor: (key: string) => string | undefined
  readonly #scheduler: Scheduler
  readonly #secretKey: string | Uint8Array
  readonly #operations: OperationAuthority
  readonly #uncertainOperations = new Set<string>()
  readonly #timeoutOperations = new Map<string, string>()
  readonly #timeoutHandles = new Map<string, unknown>()
  readonly #waitTimeouts = new Set<string>()
  #feedbackCaptureEnabled: boolean

  constructor(options: {
    readonly persistence: InteractionPersistence
    readonly runtime: InteractionRuntimePort
    readonly clock: Clock
    readonly ids: IdSource
    readonly feedbackCapture: boolean
    readonly automationRuleFor: (key: string) => string | undefined
    readonly scheduler: Scheduler
    readonly secretKey: string | Uint8Array
    readonly operationAuthority: OperationAuthority
  }) {
    this.#persistence = options.persistence
    this.#runtime = options.runtime
    this.#clock = options.clock
    this.#ids = options.ids
    this.#feedbackCaptureEnabled = options.feedbackCapture
    this.#automationRuleFor = options.automationRuleFor
    this.#scheduler = options.scheduler
    this.#secretKey = options.secretKey
    this.#operations = options.operationAuthority
    this.#rehydrateCompletedOperations()
  }

  setFeedbackCapture(enabled: boolean): void {
    this.#feedbackCaptureEnabled = enabled
  }

  schedule(record: InteractionRecord): void {
    if (record.deadlineAt === undefined || record.status !== 'pending') return
    this.#clearTimeout(record.key)
    const delay = Math.max(0, Date.parse(record.deadlineAt) - Date.parse(this.#clock.now()))
    this.#timeoutHandles.set(
      record.key,
      this.#scheduler.set(() => {
        this.#timeoutHandles.delete(record.key)
        void this.tick().then(
          () => {
            const current = this.#persistence
              .state()
              .interactions.find((interaction) => interaction.key === record.key)
            if (
              current?.status === 'pending' &&
              current.deadlineAt === record.deadlineAt &&
              !this.#waitTimeouts.has(record.key)
            ) {
              this.schedule(current)
            }
          },
          () => {},
        )
      }, delay),
    )
  }

  dispose(): void {
    for (const handle of this.#timeoutHandles.values()) this.#scheduler.clear(handle)
    this.#timeoutHandles.clear()
    this.#timeoutOperations.clear()
    this.#waitTimeouts.clear()
    this.#uncertainOperations.clear()
  }

  respond(input: RespondInteractionInput, automated = false): Promise<InteractionResponseResult> {
    return this.#respondInternal(input, automated)
  }

  cancel(input: CancelInteractionInput): Promise<InteractionResponseResult> {
    return this.#respondInternal(
      { ...input, response: { id: input.interactionId, outcome: 'cancelled' } },
      false,
    )
  }

  async tick(now = this.#clock.now()): Promise<void> {
    await tickInteractions({
      persistence: this.#persistence,
      timeoutOperations: this.#timeoutOperations,
      waitTimeouts: this.#waitTimeouts,
      respond: (input, automated) => this.#respondInternal(input, automated),
      clearTimeout: (key) => this.#clearTimeout(key),
      now,
    })
  }

  #respondInternal(
    input: RespondInteractionInput,
    automated: boolean,
  ): Promise<InteractionResponseResult> {
    try {
      assertResponseInputBounded(input)
    } catch (error) {
      return Promise.reject(
        new InteractionError(
          'INVALID_INTERACTION',
          error instanceof Error ? error.message : 'Interaction identity is invalid',
        ),
      )
    }
    if (!input.operationId) {
      return Promise.reject(
        new InteractionError('OPERATION_ID_REQUIRED', 'This action requires operationId'),
      )
    }
    try {
      assertOperationId(input.operationId)
    } catch (error) {
      return Promise.reject(
        new InteractionError(
          'OPERATION_ID_REQUIRED',
          error instanceof Error ? error.message : 'Invalid operation ID',
        ),
      )
    }
    const key = interactionKey(input.runId, input.interactionId)
    const record = this.#persistence.state().interactions.find((item) => item.key === key)
    if (!record)
      return Promise.resolve(
        responseResult(input, 'stale', false, 'Interaction is not known in this run'),
      )
    if (
      record.providerSessionId !== input.providerSessionId ||
      !bindingMatches(record, input) ||
      input.response.id !== input.interactionId
    ) {
      return Promise.resolve(
        responseResult(input, 'stale', false, 'Interaction binding does not match'),
      )
    }

    const requestDigest = record.requestDigest ?? interactionRequestDigest(record.request)
    const fingerprint = interactionResponseFingerprint(
      record.request,
      input.response,
      this.#secretKey,
    )
    const operationDigest = interactionOperationDigest(key, requestDigest, fingerprint)
    let previous: OperationRecord<StoredResponseOperation> | undefined
    try {
      previous = this.#operations.get<StoredResponseOperation>(input.operationId, operationDigest)
    } catch (error) {
      if (error instanceof OperationConflictError) {
        return Promise.resolve(
          responseResult(
            input,
            'conflict',
            true,
            'Operation was already used with different input',
          ),
        )
      }
      throw error
    }
    if (previous) {
      if (
        this.#uncertainOperations.has(input.operationId) &&
        record.resolution?.operationId === input.operationId &&
        record.resolution.outcome === input.response.outcome &&
        record.resolution.responseDigest === fingerprint
      ) {
        const resolved = this.#resolvedResult(record, input, fingerprint)
        this.#operations.replace(input.operationId, operationDigest, {
          ...previous.value,
          promise: resolved,
        })
        return resolved.then((result) => ({
          ...result,
          replayed: true,
        }))
      }
      return previous.value.promise.then((result) => ({ ...result, replayed: true }))
    }

    const state = this.#persistence.state()
    if (record.status === 'responding') {
      const pending = record.pendingResponse
      if (
        !pending ||
        pending.operationId !== input.operationId ||
        pending.requestDigest !== requestDigest ||
        pending.responseDigest !== fingerprint
      ) {
        return Promise.resolve(
          responseResult(input, 'conflict', false, 'A different response is already in progress'),
        )
      }
      return this.#reconcile(record, input, pending)
    }
    if (interactionStatusIsUncertain(record.status) && record.pendingResponse) {
      const pending = record.pendingResponse
      if (
        pending.operationId !== input.operationId ||
        pending.requestDigest !== requestDigest ||
        pending.responseDigest !== fingerprint
      ) {
        return Promise.resolve(
          responseResult(
            input,
            'conflict',
            false,
            'A different uncertain response is already recorded',
          ),
        )
      }
      return this.#reconcile(record, input, pending)
    }
    if (record.status !== 'pending') return this.#resolvedResult(record, input, fingerprint)

    const validation = validateInteractionData(
      record.request.answerSpec,
      input.response.outcome,
      input.response.data,
    )
    if (!validation.ok) {
      return Promise.resolve(
        responseResult(input, 'invalid', false, validation.errors[0] ?? 'Invalid answer'),
      )
    }
    const capabilityError = acceptedCapabilityError(
      state,
      record,
      input.response,
      validation.publicData,
      this.#runtime.capabilities,
    )
    if (capabilityError)
      return Promise.resolve(responseResult(input, 'invalid', false, capabilityError))

    let resolveOperation: (result: InteractionResponseResult) => void = () => {}
    let rejectOperation: (error: unknown) => void = () => {}
    const operationPromise = new Promise<InteractionResponseResult>((resolve, reject) => {
      resolveOperation = resolve
      rejectOperation = reject
    })
    const operation: StoredResponseOperation = {
      key,
      fingerprint,
      requestDigest,
      promise: operationPromise,
    }
    this.#operations.remember(input.operationId, operationDigest, operation)
    void this.#performResponse(record, input, validation, automated).then((result) => {
      if (
        result.status === 'transport_error' ||
        result.status === 'unknown' ||
        result.status === 'unknown_interaction' ||
        result.status === 'unknown_run'
      ) {
        this.#uncertainOperations.add(input.operationId)
      }
      resolveOperation(result)
    }, rejectOperation)
    return operation.promise
  }

  #reconcile(
    record: InteractionRecord,
    input: RespondInteractionInput,
    pending: NonNullable<InteractionRecord['pendingResponse']>,
  ): Promise<InteractionResponseResult> {
    return reconcilePendingResponse({
      persistence: this.#persistence,
      runtime: this.#runtime,
      clock: this.#clock,
      clearTimeout: (key) => this.#clearTimeout(key),
      record,
      input,
      pending,
    })
  }

  #resolvedResult(
    record: InteractionRecord,
    input: RespondInteractionInput,
    fingerprint: string,
  ): Promise<InteractionResponseResult> {
    if (
      record.resolution &&
      record.resolution.operationId === input.operationId &&
      record.resolution.outcome === input.response.outcome &&
      (record.resolution.responseDigest === undefined ||
        record.resolution.responseDigest === fingerprint)
    ) {
      return Promise.resolve(
        responseResult(input, 'already_resolved', false, 'Interaction was already resolved'),
      )
    }
    if (
      record.resolution &&
      record.resolution.responseDigest === fingerprint &&
      record.resolution.outcome === input.response.outcome
    ) {
      return Promise.resolve(
        responseResult(input, 'already_resolved', false, 'Interaction was already resolved'),
      )
    }
    return Promise.resolve(
      responseResult(input, 'conflict', false, 'Interaction was already resolved differently'),
    )
  }

  async #performResponse(
    record: InteractionRecord,
    input: RespondInteractionInput,
    validation: Extract<ReturnType<typeof validateInteractionData>, { readonly ok: true }>,
    automated: boolean,
  ): Promise<InteractionResponseResult> {
    return performInteractionResponse({
      persistence: this.#persistence,
      runtime: this.#runtime,
      clock: this.#clock,
      ids: this.#ids,
      feedbackCaptureEnabled: this.#feedbackCaptureEnabled,
      automationRuleFor: this.#automationRuleFor,
      clearTimeout: (key) => this.#clearTimeout(key),
      secretKey: this.#secretKey,
      record,
      input,
      validation,
      automated,
    })
  }

  #clearTimeout(key: string): void {
    const handle = this.#timeoutHandles.get(key)
    if (handle !== undefined) {
      this.#scheduler.clear(handle)
      this.#timeoutHandles.delete(key)
    }
    this.#timeoutOperations.delete(key)
    this.#waitTimeouts.delete(key)
  }

  #rehydrateCompletedOperations(): void {
    const events = this.#persistence.events()
    for (const record of this.#persistence.state().interactions) {
      const status = rehydratedStatus(record.status)
      if (status === undefined) continue
      const event = [...events]
        .reverse()
        .find(
          (envelope) =>
            envelope.event.kind === 'interaction.response.requested' &&
            envelope.event.key === record.key,
        )?.event
      if (event?.kind !== 'interaction.response.requested' || event.responseDigest === undefined) {
        continue
      }
      const requestDigest = event.requestDigest ?? record.requestDigest
      if (requestDigest === undefined) continue
      const input: RespondInteractionInput = {
        ...bindingForRecord(record),
        operationId: event.operationId,
        response: {
          id: record.interactionId,
          outcome: event.outcome,
          ...(event.publicData === undefined
            ? {}
            : { data: canonicalInteractionData(event.publicData) }),
        },
      }
      this.#operations.remember(
        event.operationId,
        interactionOperationDigest(record.key, requestDigest, event.responseDigest),
        {
          key: record.key,
          fingerprint: event.responseDigest,
          requestDigest,
          promise: Promise.resolve(responseResult(input, status, false)),
        },
      )
    }
  }
}

function rehydratedStatus(
  status: InteractionStatus,
): InteractionResponseResult['status'] | undefined {
  switch (status) {
    case 'resolved':
      return 'already_resolved'
    case 'declined':
    case 'cancelled':
    case 'expired':
    case 'conflict':
    case 'identity_conflict':
    case 'unsupported':
      return status
    default:
      return undefined
  }
}

function interactionOperationDigest(
  key: string,
  requestDigest: string,
  responseDigest: string,
): string {
  return canonicalDigest({
    schema: 'braid.interaction-response.v1',
    key,
    requestDigest,
    responseDigest,
  })
}
