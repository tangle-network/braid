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
  | 'conversationId'
  | 'branchId'
  | 'model'
  | 'runner'
  | 'requestRevision'
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
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    ...(record.branchId === undefined ? {} : { branchId: record.branchId }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.runner === undefined ? {} : { runner: record.runner }),
    ...(record.requestRevision === undefined ? {} : { requestRevision: record.requestRevision }),
  }
}

export function addMilliseconds(iso: string, milliseconds: number): string | undefined {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return undefined
  }
  const deadline = timestamp + milliseconds
  if (!Number.isFinite(deadline)) return undefined
  try {
    return new Date(deadline).toISOString()
  } catch {
    return undefined
  }
}
