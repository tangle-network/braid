import { canonicalInteractionData, validateInteractionData } from '../domain/interaction.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { InteractionResponseResult, RespondInteractionInput } from '../ports/interactions.js'
import { bindingForRecord } from './interaction-controller-utils.js'
import type { InteractionPersistence } from './interaction-persistence.js'

export async function tickInteractions(options: {
  readonly persistence: InteractionPersistence
  readonly timeoutOperations: Map<string, string>
  readonly waitTimeouts: Set<string>
  readonly respond: (
    input: RespondInteractionInput,
    automated: boolean,
  ) => Promise<InteractionResponseResult>
  readonly clearTimeout: (key: string) => void
  readonly now: string
}): Promise<void> {
  const { persistence, timeoutOperations, waitTimeouts, respond, clearTimeout, now } = options
  const due = persistence
    .state()
    .interactions.filter(
      (interaction) =>
        interaction.status === 'pending' &&
        interaction.deadlineAt !== undefined &&
        !waitTimeouts.has(interaction.key) &&
        Date.parse(interaction.deadlineAt) <= Date.parse(now),
    )
  for (const interaction of due) {
    const timeoutAction = interaction.request.onTimeout ?? 'wait'
    if (timeoutAction === 'wait') {
      waitTimeouts.add(interaction.key)
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
          timeoutOperations.get(interaction.key) ??
          `timeout-${canonicalDigest({ key: interaction.key, action: 'default' })}`
        timeoutOperations.set(interaction.key, operationId)
        await respond(
          {
            ...bindingForRecord(interaction),
            operationId,
            response: {
              id: interaction.interactionId,
              outcome: interaction.request.default.outcome,
              ...(defaultData === undefined ? {} : { data: canonicalInteractionData(defaultData) }),
            },
          },
          true,
        )
        continue
      }
    }
    if (timeoutAction === 'fail') {
      const operationId =
        timeoutOperations.get(interaction.key) ??
        `timeout-${canonicalDigest({ key: interaction.key, action: 'fail' })}`
      timeoutOperations.set(interaction.key, operationId)
      await respond(
        {
          ...bindingForRecord(interaction),
          operationId,
          response: { id: interaction.interactionId, outcome: 'declined' },
        },
        false,
      )
      continue
    }
    persistence.commit({
      kind: 'interaction.resolved',
      key: interaction.key,
      status: 'expired',
      reason: 'Interaction timed out without a safe automatic response',
    })
    clearTimeout(interaction.key)
  }
}
