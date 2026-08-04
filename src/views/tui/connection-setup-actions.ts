import type { SelectItem } from '@earendil-works/pi-tui'
import type { ConnectionSummary } from '../../app/connection-action-types.js'
import type { BraidIntent } from '../shared/intents.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'

export function connectionItemName(item: SelectItem): string {
  return item.label.replace(/^✓\s/u, '')
}

export function selectConnectionIntent(
  item: SelectItem,
  operationId: string,
  expectedRevision: number,
): BraidIntent {
  return {
    type: 'headless-command',
    command: 'select_connection',
    operationId,
    params: { connectionId: item.value, expectedRevision },
  }
}

export function testConnectionIntent(item: SelectItem, operationId: string): BraidIntent {
  return {
    type: 'headless-command',
    command: 'test_connection',
    operationId,
    params: { connectionId: item.value },
  }
}

export function connectionErrorMessage(error: unknown, fallback: string): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : fallback)
}

export function readConnectionTest(value: unknown): ConnectionSummary | undefined {
  if (!isRecord(value) || !('connection' in value)) return undefined
  const connection = value.connection
  if (
    !isRecord(connection) ||
    typeof connection.id !== 'string' ||
    typeof connection.name !== 'string' ||
    typeof connection.kind !== 'string' ||
    typeof connection.credentialConfigured !== 'boolean' ||
    typeof connection.ready !== 'boolean' ||
    !isHealth(connection.health) ||
    !Array.isArray(connection.capabilityHints)
  )
    return undefined
  return connection as unknown as ConnectionSummary
}

function isHealth(value: unknown): value is { readonly status: string } {
  return isRecord(value) && 'status' in value && typeof value.status === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
