import type { BraidState } from './state.js'
import { fail } from './invariants-base.js'

export function assertStateRelations(state: BraidState): void {
  if (state.conversations.length === 0) return
  const conversations = new Map(state.conversations.map((record) => [record.id, record]))
  const branches = new Map(state.branches.map((record) => [record.id, record]))
  const messages = new Map(state.messages.map((record) => [record.id, record]))
  const turns = new Map(state.turns.map((record) => [record.id, record]))
  const runs = new Map(state.runs.map((record) => [record.id, record]))
  const drafts = new Map(state.drafts.map((record) => [record.id, record]))
  const queues = new Map(state.queues.map((record) => [record.id, record]))

  const selectedConversation = conversations.get(state.conversationId)
  if (!selectedConversation || selectedConversation.deletedAt !== undefined) {
    fail('state.conversationId must reference an available conversation')
  }
  const selectedBranch = branches.get(state.branchId)
  if (!selectedBranch || selectedBranch.conversationId !== selectedConversation.id) {
    fail('state.branchId must belong to the selected conversation')
  }

  for (const conversation of state.conversations) {
    if (conversation.deletedAt !== undefined) continue
    const activeBranch = branches.get(conversation.activeBranchId)
    if (!activeBranch || activeBranch.conversationId !== conversation.id) {
      fail(`conversation ${conversation.id} has an invalid active branch`)
    }
  }

  for (const branch of state.branches) {
    const conversation = conversations.get(branch.conversationId)
    if (!conversation || conversation.deletedAt !== undefined) {
      fail(`branch ${branch.id} has no available conversation`)
    }
    const draft = drafts.get(branch.draftId)
    if (!draft || draft.branchId !== branch.id) fail(`branch ${branch.id} has an invalid draft`)
    const queue = queues.get(branch.queueId)
    if (!queue || queue.branchId !== branch.id) fail(`branch ${branch.id} has an invalid queue`)
    if (branch.tipMessageId !== undefined) {
      const tip = messages.get(branch.tipMessageId)
      if (!tip) fail(`branch ${branch.id} has a missing tip message`)
    }
    if (branch.source !== undefined) {
      const source = branches.get(branch.source.branchId)
      if (!source || source.conversationId !== branch.source.conversationId) {
        fail(`branch ${branch.id} has an invalid source branch`)
      }
      if (
        branch.source.throughMessageId !== undefined &&
        !messages.has(branch.source.throughMessageId)
      ) {
        fail(`branch ${branch.id} has a missing source message`)
      }
      if (branch.source.throughTurnId !== undefined && !turns.has(branch.source.throughTurnId)) {
        fail(`branch ${branch.id} has a missing source turn`)
      }
    }
  }

  for (const message of state.messages) {
    const branch = branches.get(message.branchId)
    if (!branch || branch.conversationId !== message.conversationId) {
      fail(`message ${message.id} has an invalid branch`)
    }
    if (message.turnId !== undefined && !turns.has(message.turnId)) {
      fail(`message ${message.id} has a missing turn`)
    }
    if (message.runId !== undefined && !runs.has(message.runId)) {
      fail(`message ${message.id} has a missing run`)
    }
  }

  for (const turn of state.turns) {
    const branch = branches.get(turn.branchId)
    if (!branch || branch.conversationId !== turn.conversationId) {
      fail(`turn ${turn.id} has an invalid branch`)
    }
    const userMessage = messages.get(turn.userMessageId)
    if (!userMessage || userMessage.turnId !== turn.id || userMessage.role !== 'user') {
      fail(`turn ${turn.id} has an invalid user message`)
    }
    for (const runId of turn.runIds) {
      const run = runs.get(runId)
      if (!run || run.turnId !== turn.id) fail(`turn ${turn.id} has an invalid run`)
    }
    if (turn.selectedRunId !== undefined && !turn.runIds.includes(turn.selectedRunId)) {
      fail(`turn ${turn.id} selected a run outside the turn`)
    }
  }

  for (const run of state.runs) {
    const branch = branches.get(run.branchId)
    if (!branch || branch.conversationId !== run.conversationId) {
      fail(`run ${run.id} has an invalid branch`)
    }
    if (!turns.has(run.turnId)) fail(`run ${run.id} has a missing turn`)
  }

  for (const draft of state.drafts) {
    if (!branches.has(draft.branchId)) fail(`draft ${draft.id} has a missing branch`)
  }
  for (const queue of state.queues) {
    if (!branches.has(queue.branchId)) fail(`queue ${queue.id} has a missing branch`)
    for (const entryId of queue.entryIds) {
      const entry = state.queueEntries.find((candidate) => candidate.id === entryId)
      if (!entry || entry.queueId !== queue.id) fail(`queue ${queue.id} has an invalid entry`)
    }
  }
}
