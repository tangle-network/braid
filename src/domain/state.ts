import type { AgentProfile } from '@tangle-network/agent-interface'

export type MessageRole = 'user' | 'assistant'
export type MessageStatus = 'complete' | 'streaming' | 'failed' | 'aborted' | 'blocked'
export type RunStatus = 'streaming' | 'completed' | 'failed' | 'aborted' | 'blocked'

export interface BraidMessage {
  readonly id: string
  readonly role: MessageRole
  readonly text: string
  readonly status: MessageStatus
  readonly runId?: string
}

export interface BraidRun {
  readonly id: string
  readonly turnId: string
  readonly operationId: string
  readonly status: RunStatus
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd?: number
  readonly model?: string
  readonly error?: string
}

export interface BraidState {
  readonly schemaVersion: 1
  readonly revision: number
  readonly sequence: number
  readonly workspace: string | null
  readonly conversationId: string
  readonly branchId: string
  readonly profile: Readonly<AgentProfile>
  readonly draft: string
  readonly messages: readonly BraidMessage[]
  readonly runs: readonly BraidRun[]
  readonly activeRunId: string | null
  readonly lastError: string | null
}

export function initialState(profile: Readonly<AgentProfile>): BraidState {
  return {
    schemaVersion: 1,
    revision: 0,
    sequence: 0,
    workspace: null,
    conversationId: 'conv-1',
    branchId: 'branch-1',
    profile,
    draft: '',
    messages: [],
    runs: [],
    activeRunId: null,
    lastError: null,
  }
}
