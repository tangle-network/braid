import type { BraidApplication } from '../app/application.js'
import type { ConnectionRecord } from '../domain/entities.js'

export function hasDurableOperation(app: BraidApplication, operationId: string): boolean {
  return app.state().operations.some((operation) => operation.id === operationId)
}

/** Finds the last safe connection record even after its live catalog entry was removed. */
export function historicalConnectionRecord(
  app: BraidApplication,
  connectionId: string,
): ConnectionRecord | undefined {
  const current = app.state().connections.find((record) => record.id === connectionId)
  if (current !== undefined) return current
  for (const { event } of [...app.events()].reverse()) {
    if (event.kind === 'connection.upserted' && event.connection.id === connectionId) {
      return event.connection
    }
  }
  return undefined
}

/** Recovers the exact record committed beside one acknowledged connection operation. */
export function connectionRecordForOperation(
  app: BraidApplication,
  operationId: string,
): ConnectionRecord | undefined {
  const events = app.events()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event
    if (event?.kind !== 'operation.updated' || event.operation.id !== operationId) continue
    const connectionId = event.operation.target?.id
    for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = events[candidateIndex]?.event
      if (candidate?.kind === 'operation.updated') break
      if (
        candidate?.kind === 'connection.upserted' &&
        (connectionId === undefined || candidate.connection.id === connectionId)
      ) {
        return candidate.connection
      }
    }
  }
  return undefined
}
