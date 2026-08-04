import { canonicalDigest } from '../domain/canonical.js'
import type { AnalysisAttachmentRecord, BranchRecord, MessageRecord } from '../domain/entities.js'
import type { BranchId } from '../domain/ids.js'
import {
  createPortableContextPlan,
  type PortableAnalysisAttachment,
  type PortableContextMessage,
  type PortableContextPart,
  type PortableContextPlan,
} from '../domain/receipts.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import type { ConversationHost, PlanContextInput } from './conversation-types.js'
import { messagesThroughBoundary, messagesVisibleOnBranch } from './conversation-visibility.js'
import { AppError } from './errors.js'

export { messagesVisibleOnBranch } from './conversation-visibility.js'

const MAX_CONTEXT_MESSAGES = 20_000
const MAX_CONTEXT_BYTES = 2 * 1024 * 1024

function portablePart(part: MessageRecord['parts'][number]): PortableContextPart | undefined {
  const id = part.id
  switch (part.kind) {
    case 'reasoning':
      return undefined
    case 'text':
      return { id, type: 'text', text: redactSensitiveText(part.text ?? '') }
    case 'artifact':
      return part.uri
        ? {
            id,
            type: 'artifact',
            uri: redactSensitiveText(part.uri, 4096),
            ...(part.mimeType === undefined ? {} : { mediaType: part.mimeType }),
          }
        : { id, type: 'unknown', summary: 'Artifact reference unavailable' }
    case 'tool-call':
      return {
        id,
        type: 'unknown',
        summary: `Tool request: ${redactSensitiveText(part.toolName ?? 'unknown', 256)}`,
      }
    case 'tool-result':
      return {
        id,
        type: 'unknown',
        summary: `Tool result: ${redactSensitiveText(part.toolName ?? 'unknown', 256)}`,
      }
    case 'warning':
    case 'error':
    case 'proposal':
    case 'interaction':
    case 'system':
    case 'unknown':
      return {
        id,
        type: 'unknown',
        summary: redactSensitiveText(part.text ?? part.title ?? part.kind, 4096),
      }
  }
}

function portableMessage(message: MessageRecord): {
  readonly message: PortableContextMessage
  readonly omittedPartIds: readonly string[]
} {
  const parts: PortableContextPart[] = []
  const omittedPartIds: string[] = []
  for (const part of message.parts) {
    const portable = portablePart(part)
    if (portable === undefined) omittedPartIds.push(part.id)
    else parts.push(portable)
  }
  if (parts.length === 0 && message.text) {
    parts.push({ id: `part-${message.id}`, type: 'text', text: redactSensitiveText(message.text) })
  }
  return {
    message: { id: message.id, role: message.role, parts },
    omittedPartIds,
  }
}

function analysisAttachmentsVisibleOnBranch(
  state: BraidState,
  branchId: BranchId,
  visiting: Set<string>,
): readonly AnalysisAttachmentRecord[] {
  if (visiting.has(branchId))
    throw new AppError('GRAPH_CYCLE', `Branch ancestry includes ${branchId}`)
  const branch = state.branches.find((candidate) => candidate.id === branchId)
  if (branch === undefined)
    throw new AppError('UNKNOWN_BRANCH', `Branch ${branchId} does not exist`)
  visiting.add(branchId)
  try {
    const inherited = branch.source
      ? analysisAttachmentsVisibleOnBranch(state, branch.source.branchId, visiting).filter(
          (attachment) => attachmentVisibleAtBranchCreation(attachment, branch),
        )
      : []
    const local = state.analysisAttachments.filter(
      (attachment) =>
        attachment.destinationConversationId === branch.conversationId &&
        attachment.destinationBranchId === branch.id,
    )
    const seen = new Set<string>()
    return [...inherited, ...local].filter((attachment) => {
      if (seen.has(String(attachment.id))) return false
      seen.add(String(attachment.id))
      return true
    })
  } finally {
    visiting.delete(branchId)
  }
}

function attachmentVisibleAtBranchCreation(
  attachment: AnalysisAttachmentRecord,
  branch: BranchRecord,
): boolean {
  const attachmentTime = Date.parse(attachment.createdAt)
  const branchTime = Date.parse(branch.createdAt)
  return Number.isFinite(attachmentTime) && Number.isFinite(branchTime)
    ? attachmentTime <= branchTime
    : false
}

function portableAnalysisAttachment(
  attachment: AnalysisAttachmentRecord,
): PortableAnalysisAttachment {
  return {
    analysisId: String(attachment.analysisId),
    ...(attachment.analysisRunId === undefined
      ? {}
      : { analysisRunId: String(attachment.analysisRunId) }),
    sourceDigest: String(attachment.sourceDigest),
    ...(attachment.sourceRunId === undefined
      ? {}
      : { sourceRunId: String(attachment.sourceRunId) }),
    findings: attachment.selectedFindings.map((finding) => ({
      id: finding.id,
      text: redactSensitiveText(finding.text),
      citations: finding.citations.map((citation) => ({
        id: String(citation.id),
        ...(citation.eventId === undefined ? {} : { eventId: String(citation.eventId) }),
        ...(citation.messageId === undefined ? {} : { messageId: String(citation.messageId) }),
        ...(citation.partId === undefined ? {} : { partId: String(citation.partId) }),
        ...(citation.start === undefined ? {} : { start: citation.start }),
        ...(citation.end === undefined ? {} : { end: citation.end }),
        ...(citation.quote === undefined ? {} : { quote: redactSensitiveText(citation.quote) }),
      })),
    })),
    provenance: {
      ...(attachment.provenance.analystProfileDigest === undefined
        ? {}
        : { analystProfileDigest: String(attachment.provenance.analystProfileDigest) }),
      ...(attachment.provenance.model === undefined ? {} : { model: attachment.provenance.model }),
      ...(attachment.provenance.runner === undefined
        ? {}
        : { runner: attachment.provenance.runner }),
      ...(attachment.provenance.agentEvalVersion === undefined
        ? {}
        : { agentEvalVersion: attachment.provenance.agentEvalVersion }),
    },
  }
}

export function portablePlanForState(
  state: BraidState,
  input: PlanContextInput,
): PortableContextPlan {
  const branch = resolveBranch(state, input.branchId)
  const visible = messagesVisibleOnBranch(state, branch.id)
  if (visible.length > MAX_CONTEXT_MESSAGES) {
    throw new AppError('CONTEXT_TOO_LARGE', 'Conversation context has too many messages')
  }
  const through =
    input.throughMessageId === undefined
      ? visible.at(-1)
      : visible.find((message) => message.id === input.throughMessageId)
  if (through === undefined && input.throughMessageId === undefined && visible.length === 0) {
    const analysisAttachments = analysisAttachmentsVisibleOnBranch(state, branch.id, new Set()).map(
      portableAnalysisAttachment,
    )
    return createPortableContextPlan({
      sourceRunId: `run-context-${canonicalDigest({ branchId: branch.id }).slice(0, 24)}`,
      sourceBoundary: branch.id,
      ...(input.destinationRunner === undefined
        ? {}
        : { destinationRunner: input.destinationRunner }),
      messages: [],
      ...(analysisAttachments.length === 0 ? {} : { analysisAttachments }),
      complete: true,
      tokenEstimate: 0,
    })
  }
  if (!through) {
    throw new AppError(
      'UNKNOWN_MESSAGE_BOUNDARY',
      input.throughMessageId
        ? `Message ${input.throughMessageId} is not visible on branch ${branch.id}`
        : 'The selected branch has no message boundary',
    )
  }
  const selected = messagesThroughBoundary(visible, through.id)
  const converted = selected.map(portableMessage)
  const messages = converted.map((entry) => entry.message)
  const analysisAttachments = analysisAttachmentsVisibleOnBranch(state, branch.id, new Set()).map(
    portableAnalysisAttachment,
  )
  const omittedPartIds = converted.flatMap((entry) => entry.omittedPartIds)
  const bytes = Buffer.byteLength(JSON.stringify({ messages, analysisAttachments }), 'utf8')
  if (bytes > MAX_CONTEXT_BYTES) {
    throw new AppError('CONTEXT_TOO_LARGE', 'Conversation context exceeds 2 MiB')
  }
  const sourceRunId =
    through.runId ??
    selected
      .map((message) => message.runId)
      .filter((value): value is NonNullable<typeof value> => value !== undefined)
      .at(-1) ??
    `run-context-${canonicalDigest({ branchId: branch.id, through: through.id }).slice(0, 24)}`
  return createPortableContextPlan({
    sourceRunId,
    sourceBoundary: through.id,
    ...(input.destinationRunner === undefined
      ? {}
      : { destinationRunner: input.destinationRunner }),
    messages,
    ...(analysisAttachments.length === 0 ? {} : { analysisAttachments }),
    omittedPartIds,
    complete: selected.every((message) => message.complete),
    tokenEstimate: Math.ceil(bytes / 4),
  })
}

function resolveBranch(state: BraidState, branchId: string | undefined): BranchRecord {
  const id = branchId ?? state.branchId
  const branch = state.branches.find((candidate) => candidate.id === id)
  if (!branch) throw new AppError('UNKNOWN_BRANCH', `Branch ${id} does not exist`)
  return branch
}

export class ConversationContext {
  readonly #host: ConversationHost

  constructor(host: ConversationHost) {
    this.#host = host
  }

  plan(input: PlanContextInput): PortableContextPlan {
    return portablePlanForState(this.#host.state(), input)
  }
}
