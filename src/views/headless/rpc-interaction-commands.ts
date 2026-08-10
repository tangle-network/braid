import { parseInteractionResponse } from '../../app/interaction-response.js'
import { RpcParseError } from './rpc-errors.js'

export type InteractionCommand = 'respond_interaction' | 'cancel_interaction'

export function validateInteractionParameters(
  command: InteractionCommand,
  params: Readonly<Record<string, unknown>>,
): void {
  if (typeof params.runId !== 'string' || params.runId.length === 0)
    throw new RpcParseError('INVALID_PARAMS', `${command}.params.runId must be a non-empty string`)
  if (typeof params.interactionId !== 'string' || params.interactionId.length === 0)
    throw new RpcParseError(
      'INVALID_PARAMS',
      `${command}.params.interactionId must be a non-empty string`,
    )
  if (command === 'cancel_interaction') return
  const response = parseInteractionResponse(params.response)
  if (response === undefined)
    throw new RpcParseError('INVALID_PARAMS', 'respond_interaction.params.response is invalid')
  if (response.id !== params.interactionId)
    throw new RpcParseError(
      'INVALID_PARAMS',
      'respond_interaction.params.response.id must match interactionId',
    )
}
