import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'

export interface ConversationItem {
  readonly id: string
  readonly title: string
  readonly branchId: string
  readonly archived: boolean
}

export interface OverlaySelectItem {
  readonly value: string
  readonly label: string
  readonly description: string
}

export function conversationItems(view: BraidViewModel): readonly OverlaySelectItem[] {
  return [...view.conversations]
    .sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1
      return right.updatedAt.localeCompare(left.updatedAt)
    })
    .map((conversation) => ({
      value: conversation.id,
      label: conversation.title,
      description: `${conversation.archived ? 'archived' : 'active'} ${conversationDate(conversation.updatedAt)} branch ws:${displayWorkspace(view.workspace)} ${conversation.branchId} ${view.workspace ?? ''}`,
    }))
}

export function branchItems(view: BraidViewModel): readonly OverlaySelectItem[] {
  const seen = new Set<string>()
  const items = view.graph
    .filter((node) => node.type === 'branch')
    .filter((node) => {
      if (seen.has(node.id)) return false
      seen.add(node.id)
      return true
    })
    .map((node) => ({
      value: node.id,
      label: node.title,
      description: `${node.id === view.branch ? 'current · ' : ''}${node.status} · ${node.id}`,
    }))
  if (!seen.has(view.branch))
    items.unshift({
      value: view.branch,
      label: 'current branch',
      description: `current · ${view.branch}`,
    })
  return items
}

export function findConversation(
  view: BraidViewModel,
  conversationId: string,
): ConversationItem | undefined {
  const conversation = view.conversations.find((candidate) => candidate.id === conversationId)
  return conversation === undefined
    ? undefined
    : {
        id: conversation.id,
        title: conversation.title,
        branchId: conversation.branchId,
        archived: conversation.archived,
      }
}

export function fieldValue(
  preview: BraidViewModel['forkPreview'],
  label: string,
): string | undefined {
  return preview?.fields.find((field) => field.label === label)?.source
}

export function forkExecutionIdentity(
  preview: BraidViewModel['forkPreview'],
): { readonly operationId: string; readonly planDigest: string } | undefined {
  if (!preview?.allowed) return undefined
  const operationId = fieldValue(preview, 'operation id')
  const planDigest = fieldValue(preview, 'plan digest')
  return operationId === undefined || planDigest === undefined
    ? undefined
    : { operationId, planDigest }
}

export function resultMessage(
  result: import('../shared/intents.js').UiDispatchResult,
  fallback: string,
): string {
  if (result.kind === 'accepted') return result.notice ?? fallback
  return result.kind === 'unavailable' ? result.reason : result.message
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function conversationDate(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp)
    ? sanitizeTerminalText(value)
    : new Date(timestamp).toISOString().slice(0, 10)
}

function displayWorkspace(value: string | null): string {
  return (value ?? 'unavailable').replace(/^\//u, '')
}
