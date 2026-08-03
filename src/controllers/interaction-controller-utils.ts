import type { InteractionRecord } from '../domain/interaction-state.js'
import type { RespondInteractionInput } from '../ports/interactions.js'

export type InteractionBinding = Pick<
  RespondInteractionInput,
  | 'runId'
  | 'interactionId'
  | 'providerSessionId'
  | 'profileDigest'
  | 'connectionId'
  | 'workspaceId'
  | 'runner'
>

export function bindingForRecord(record: InteractionRecord): InteractionBinding {
  return {
    runId: record.runId,
    interactionId: record.interactionId,
    ...(record.providerSessionId === undefined
      ? {}
      : { providerSessionId: record.providerSessionId }),
    ...(record.profileDigest === undefined ? {} : { profileDigest: record.profileDigest }),
    ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    ...(record.runner === undefined ? {} : { runner: record.runner }),
  }
}

export function addMilliseconds(iso: string, milliseconds: number): string | undefined {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp) || !Number.isFinite(milliseconds) || milliseconds <= 0) {
    return undefined
  }
  return new Date(timestamp + milliseconds).toISOString()
}
