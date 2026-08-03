import {
  canonicalInteractionData,
  interactionResponseDigest,
  validateInteractionData,
} from '../domain/interaction.js'
import type { InteractionRecord } from '../domain/interaction-state.js'
import type { Clock } from '../ports/clock.js'
import type {
  CancelInteractionInput,
  InteractionAck,
  InteractionResponseResult,
  InteractionRuntimePort,
  RespondInteractionInput,
} from '../ports/interactions.js'
import type { IdSource } from '../ports/ids.js'
import {
  bindingMatches,
  acceptedCapabilityError,
  responseResult,
  statusFromAck,
} from './interaction-response-policy.js'
import { bindingForRecord } from './interaction-controller-utils.js'
import { InteractionError } from './interaction-error.js'
import { recordInteractionFeedback } from './interaction-feedback.js'
import type { InteractionPersistence } from './interaction-persistence.js'

interface StoredResponseOperation {
  readonly key: string
  readonly fingerprint?: string
  readonly promise: Promise<InteractionResponseResult>
}

export class InteractionResponse {
  readonly #persistence: InteractionPersistence
  readonly #runtime: InteractionRuntimePort
  readonly #clock: Clock
  readonly #ids: IdSource
  readonly #automationRuleFor: (key: string) => string | undefined
  readonly #responses = new Map<string, StoredResponseOperation>()
  readonly #timeoutOperations = new Map<string, string>()
  readonly #waitTimeouts = new Set<string>()
  #feedbackCaptureEnabled: boolean

  constructor(options: {
    readonly persistence: InteractionPersistence
    readonly runtime: InteractionRuntimePort
    readonly clock: Clock
    readonly ids: IdSource
    readonly feedbackCapture: boolean
    readonly automationRuleFor: (key: string) => string | undefined
  }) {
    this.#persistence = options.persistence
    this.#runtime = options.runtime
    this.#clock = options.clock
    this.#ids = options.ids
    this.#feedbackCaptureEnabled = options.feedbackCapture
    this.#automationRuleFor = options.automationRuleFor
  }

  setFeedbackCapture(enabled: boolean): void {
    this.#feedbackCaptureEnabled = enabled
  }

  respond(input: RespondInteractionInput, automated = false): Promise<InteractionResponseResult> {
    return this.#respondInternal(input, automated)
  }

  cancel(input: CancelInteractionInput): Promise<InteractionResponseResult> {
    return this.#respondInternal(
      {
        ...input,
        response: { id: input.interactionId, outcome: 'cancelled' },
      },
      false,
    )
  }

  async tick(now = this.#clock.now()): Promise<void> {
    const state = this.#persistence.state()
    const due = state.interactions.filter(
      (interaction) =>
        interaction.status === 'pending' &&
        interaction.deadlineAt !== undefined &&
        !this.#waitTimeouts.has(interaction.key) &&
        Date.parse(interaction.deadlineAt) <= Date.parse(now),
    )
    for (const interaction of due) {
      const timeoutAction = interaction.request.onTimeout ?? 'wait'
      if (timeoutAction === 'wait') {
        this.#waitTimeouts.add(interaction.key)
        continue
      }
      if (timeoutAction === 'default' && interaction.request.default) {
        const defaultData = interaction.request.default.data
        const validation = validateInteractionData(
          interaction.request.answerSpec,
          interaction.request.default.outcome,
          defaultData === undefined ? undefined : canonicalInteractionData(defaultData),
        )
        if (validation.ok && !validation.containsSecret) {
          const operationId =
            this.#timeoutOperations.get(interaction.key) ?? this.#ids.next('operation')
          this.#timeoutOperations.set(interaction.key, operationId)
          await this.#respondInternal(
            {
              ...bindingForRecord(interaction),
              operationId,
              response: {
                id: interaction.interactionId,
                outcome: interaction.request.default.outcome,
                ...(defaultData === undefined
                  ? {}
                  : { data: canonicalInteractionData(defaultData) }),
              },
            },
            true,
          )
          continue
        }
      }
      if (timeoutAction === 'fail') {
        const operationId =
          this.#timeoutOperations.get(interaction.key) ?? this.#ids.next('operation')
        this.#timeoutOperations.set(interaction.key, operationId)
        await this.#respondInternal(
          {
            ...bindingForRecord(interaction),
            operationId,
            response: { id: interaction.interactionId, outcome: 'declined' },
          },
          false,
        )
        continue
      }
      this.#persistence.commit({
        kind: 'interaction.resolved',
        key: interaction.key,
        status: 'expired',
        reason: 'Interaction timed out without a safe automatic response',
      })
    }
  }

  #respondInternal(
    input: RespondInteractionInput,
    automated: boolean,
  ): Promise<InteractionResponseResult> {
    if (!input.operationId) {
      return Promise.reject(
        new InteractionError('OPERATION_ID_REQUIRED', 'This action requires operationId'),
      )
    }
    const key = `${input.runId}:${input.interactionId}`
    const record = this.#persistence
      .state()
      .interactions.find((interaction) => interaction.key === key)
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

    const containsSecret = record.request.answerSpec.fields.some((field) => field.type === 'secret')
    const fingerprint = interactionResponseDigest(record.request, input.response)
    const previous = this.#responses.get(input.operationId)
    if (previous) {
      if (previous.key !== key || (!containsSecret && previous.fingerprint !== fingerprint)) {
        return Promise.resolve(
          responseResult(
            input,
            'conflict',
            true,
            'Operation was already used with different input',
          ),
        )
      }
      return previous.promise.then((result) => ({ ...result, replayed: true }))
    }
    const state = this.#persistence.state()
    if (record.status !== 'pending') {
      if (
        record.resolution &&
        record.resolution.operationId === input.operationId &&
        record.resolution.outcome === input.response.outcome
      ) {
        return Promise.resolve(
          responseResult(input, 'already_resolved', false, 'Interaction was already resolved'),
        )
      }
      if (
        record.resolution &&
        !containsSecret &&
        record.resolution.dataDigest === fingerprint &&
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
    const operation: StoredResponseOperation = {
      key,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      promise: this.#performResponse(record, input, validation, automated),
    }
    this.#responses.set(input.operationId, operation)
    return operation.promise
  }

  async #performResponse(
    record: InteractionRecord,
    input: RespondInteractionInput,
    validation: Extract<ReturnType<typeof validateInteractionData>, { readonly ok: true }>,
    automated: boolean,
  ): Promise<InteractionResponseResult> {
    const persistedPublicData = validation.containsSecret ? {} : validation.publicData
    this.#persistence.commit({
      kind: 'interaction.response.requested',
      key: record.key,
      runId: record.runId,
      interactionId: record.interactionId,
      operationId: input.operationId,
      outcome: input.response.outcome,
      ...(Object.keys(persistedPublicData).length === 0 ? {} : { publicData: persistedPublicData }),
      ...(validation.dataDigest === undefined ? {} : { dataDigest: validation.dataDigest }),
      containsSecret: validation.containsSecret,
    })
    let ack: InteractionAck
    try {
      ack = await this.#runtime.respondToInteraction({
        ...bindingForRecord(record),
        response: input.response,
        operationId: input.operationId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch {
      ack = {
        status: 'transport_error',
        runId: record.runId,
        interactionId: record.interactionId,
        operationId: input.operationId,
        reason: 'The provider did not acknowledge the interaction response',
      }
    }
    const outcomeStatus = statusFromAck(ack, input.response.outcome)
    if (outcomeStatus === 'conflict') {
      this.#persistence.commit({
        kind: 'interaction.resolved',
        key: record.key,
        status: 'conflict',
        reason: 'The provider rejected a conflicting interaction response',
      })
      return responseResult(
        input,
        'conflict',
        false,
        'The provider rejected a conflicting response',
      )
    }
    if (outcomeStatus === 'unknown') {
      this.#persistence.commit({
        kind: 'interaction.resolved',
        key: record.key,
        status: 'unknown',
        reason: 'The provider response outcome is unknown',
      })
      return responseResult(
        input,
        'transport_error',
        false,
        'The provider response outcome is unknown',
      )
    }
    this.#persistence.commit({
      kind: 'interaction.resolved',
      key: record.key,
      status: outcomeStatus,
      resolution: {
        outcome: ack.resolvedOutcome ?? input.response.outcome,
        operationId: input.operationId,
        ...(Object.keys(persistedPublicData).length === 0
          ? {}
          : { publicData: persistedPublicData }),
        ...(validation.dataDigest === undefined ? {} : { dataDigest: validation.dataDigest }),
        containsSecret: validation.containsSecret,
        resolvedAt: this.#clock.now(),
      },
    })
    recordInteractionFeedback({
      persistence: this.#persistence,
      clock: this.#clock,
      ids: this.#ids,
      enabled: this.#feedbackCaptureEnabled,
      record,
      outcome: ack.resolvedOutcome ?? input.response.outcome,
      automated,
      ...(validation.dataDigest === undefined ? {} : { dataDigest: validation.dataDigest }),
      publicData: validation.publicData,
    })
    if (automated) {
      const ruleId = this.#automationRuleFor(record.key)
      if (ruleId) {
        this.#persistence.commit({
          kind: 'automation.audit.recorded',
          audit: {
            id: this.#ids.next('audit'),
            interactionKey: record.key,
            ruleId,
            kind: record.request.kind,
            outcome: 'applied',
            createdAt: this.#clock.now(),
          },
        })
        this.#persistence.commit({ kind: 'automation.rule.used', ruleId })
      }
    }
    if (ack.status === 'unknown_interaction')
      return responseResult(input, 'unknown_interaction', false)
    if (ack.status === 'unknown_run') return responseResult(input, 'unknown_run', false)
    if (ack.status === 'declined') return responseResult(input, 'declined', false)
    if (ack.status === 'cancelled') return responseResult(input, 'cancelled', false)
    if (ack.status === 'expired') return responseResult(input, 'expired', false)
    if (ack.status === 'already_resolved') return responseResult(input, 'already_resolved', false)
    return responseResult(
      input,
      input.response.outcome === 'declined'
        ? 'declined'
        : input.response.outcome === 'cancelled'
          ? 'cancelled'
          : 'accepted',
      false,
    )
  }
}
