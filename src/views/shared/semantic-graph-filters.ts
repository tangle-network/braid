import type { NodeDescriptor } from './semantic-graph-nodes.js'
import { SEMANTIC_NODE_TYPES, type SemanticNodeType } from './semantic-query-types.js'

export interface ParsedGraphQuery {
  readonly terms: readonly string[]
  readonly type?: SemanticNodeType
  readonly status?: string
  readonly runner?: string
  readonly edgeKind?: string
}

export function compareSemanticText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function parseGraphQuery(input: string): ParsedGraphQuery {
  let type: SemanticNodeType | undefined
  let status: string | undefined
  let runner: string | undefined
  let edgeKind: string | undefined
  const terms: string[] = []
  for (const token of input.trim().split(/\s+/u).filter(Boolean)) {
    const separator = token.indexOf(':')
    if (separator > 0) {
      const name = token.slice(0, separator).toLowerCase()
      const value = token.slice(separator + 1).toLowerCase()
      if (name === 'type' || name === 'kind') {
        if ((SEMANTIC_NODE_TYPES as readonly string[]).includes(value))
          type = value as SemanticNodeType
        else terms.push(token.toLowerCase())
        continue
      }
      if (name === 'status') {
        status = value
        continue
      }
      if (name === 'runner') {
        runner = value
        continue
      }
      if (name === 'edge') {
        edgeKind = value
        continue
      }
    }
    terms.push(token.toLowerCase())
  }
  return {
    terms,
    ...(type === undefined ? {} : { type }),
    ...(status === undefined ? {} : { status }),
    ...(runner === undefined ? {} : { runner }),
    ...(edgeKind === undefined ? {} : { edgeKind }),
  }
}

export function compareNodes(left: NodeDescriptor, right: NodeDescriptor): number {
  const dates = Date.parse(left.createdAt) - Date.parse(right.createdAt)
  if (Number.isFinite(dates) && dates !== 0) return dates
  const types = SEMANTIC_NODE_TYPES.indexOf(left.type) - SEMANTIC_NODE_TYPES.indexOf(right.type)
  if (types !== 0) return types
  return compareSemanticText(left.id, right.id)
}
