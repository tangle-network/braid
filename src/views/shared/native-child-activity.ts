import type { ChildTaskEvent, TokenUsage } from '@tangle-network/agent-interface'
import type { BraidRun } from '../../domain/state.js'
import { sanitizeTerminalText, sanitizeTitle } from './sanitize.js'
import type { SemanticActivityItem } from './semantic-query-types.js'

/** Native child identifiers are local to their owning run, never Runtime worker identifiers. */
function childActivityId(runId: string, childId: string): string {
  return `native-child:${JSON.stringify([runId, childId])}`
}

export function nativeChildActivity(run: BraidRun): readonly SemanticActivityItem[] {
  const children = run.nativeChildren?.children ?? []
  const byId = new Map(children.map((child) => [child.childId, child] as const))
  return children.map((child) => {
    const ancestry = childAncestry(child, byId)
    const detail = [
      `Native child · ${child.status} · read only`,
      `child: ${child.childId}`,
      `runner: ${child.runner ?? 'not reported'}`,
      `model: ${child.model ?? 'not reported'}`,
      ...usageLines(child.usage),
      ...(child.parentChildId === undefined ? [] : [`parent child: ${child.parentChildId}`]),
      ...(ancestry.reason === undefined ? [] : [`ancestry: ${ancestry.reason}`]),
      ...(child.terminalReason === undefined ? [] : [`terminal reason: ${child.terminalReason}`]),
      ...(run.nativeChildren?.truncated ? ['Native child history is incomplete.'] : []),
    ].map(sanitizeTerminalText)
    return {
      id: childActivityId(run.id, child.childId),
      kind: 'native-child',
      title: sanitizeTitle(child.title ?? child.childId) || '[untitled native child]',
      status: child.status,
      occurredAt: new Date(child.time.updated).toISOString(),
      startedAt: new Date(child.time.started).toISOString(),
      ...(child.time.ended === undefined
        ? {}
        : { elapsedMs: child.time.ended - child.time.started }),
      detail: detail.join('\n'),
      sourceEventId: child.sourceEventId,
      runId: run.id,
      parentId:
        child.parentChildId === undefined
          ? `run:${run.id}`
          : childActivityId(run.id, child.parentChildId),
      depth: ancestry.depth,
    }
  })
}

function childAncestry(
  child: ChildTaskEvent,
  children: ReadonlyMap<string, ChildTaskEvent>,
): { readonly depth: number; readonly reason?: string } {
  const seen = new Set([child.childId])
  let parentId = child.parentChildId
  let depth = 1
  while (parentId !== undefined) {
    if (seen.has(parentId)) return { depth: 0, reason: 'cycle reported; depth unknown' }
    seen.add(parentId)
    const parent = children.get(parentId)
    if (parent === undefined) return { depth: 0, reason: 'parent not reported; depth unknown' }
    depth += 1
    parentId = parent.parentChildId
  }
  return { depth }
}

function usageLines(usage: TokenUsage | undefined): readonly string[] {
  if (usage === undefined) return ['tokens: not reported', 'cost: not reported']
  return [
    `observed tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`,
    ...(usage.totalTokens === undefined ? [] : [`reported total tokens: ${usage.totalTokens}`]),
    ...(usage.reasoningTokens === undefined ? [] : [`reasoning tokens: ${usage.reasoningTokens}`]),
    ...(usage.cacheReadInputTokens === undefined
      ? []
      : [`cache read tokens: ${usage.cacheReadInputTokens}`]),
    ...(usage.cacheCreationInputTokens === undefined
      ? []
      : [`cache creation tokens: ${usage.cacheCreationInputTokens}`]),
    usage.cost === undefined ? 'cost: not reported' : `reported cost: $${usage.cost.toFixed(4)}`,
    'Child usage is shown separately; it is not added to run totals.',
  ]
}
