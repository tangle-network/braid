import type { AgentProfile } from '@tangle-network/agent-interface'
import { assertBoundedStructure } from './bounds.js'

const SENSITIVE_KEY =
  /(?:secret|token|password|passwd|credential|authorization|api[-_]?key|private[-_]?key)/iu

export function redactedProfile(profile: Readonly<AgentProfile>): Readonly<AgentProfile> {
  assertBoundedStructure(profile, { maxDepth: 16 })
  return redactValue(profile) as Readonly<AgentProfile>
}

export function sensitiveProfileValues(profile: Readonly<AgentProfile>): readonly string[] {
  const values = new Set<string>()
  const visit = (value: unknown, key?: string, insideMetadata = false): void => {
    if (typeof value === 'string') {
      if (insideMetadata || (key !== undefined && SENSITIVE_KEY.test(key))) values.add(value)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [name, child] of Object.entries(value)) {
      visit(child, name, insideMetadata || name === 'metadata')
    }
  }
  visit(profile)
  return [...values]
}

function redactValue(value: unknown, key?: string): unknown {
  if (key === 'metadata') return {}
  if (key && SENSITIVE_KEY.test(key)) return undefined
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([name, child]) => {
        const redacted = redactValue(child, name)
        return redacted === undefined ? [] : [[name, redacted]]
      }),
    )
  }
  return value
}
