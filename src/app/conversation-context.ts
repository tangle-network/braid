import type {
  BackendMessage,
  PortableContextPlan as CanonicalPortableContextPlan,
  InputPart,
  PortableContextDestination,
  PortableContextMessagePlan,
  PortableContextPartPlan,
  PortableContextSourceBoundary,
  PortableConversationContext,
  Sha256Digest,
} from '@tangle-network/agent-interface'
import {
  portableContextPlanDigest,
  portableConversationContextDigest,
} from '@tangle-network/agent-interface'
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
const MAX_CANONICAL_CONTEXT_MESSAGES = 1_024
const MAX_CANONICAL_CONTEXT_PARTS = 1_024
const MAX_CANONICAL_PLAN_BYTES = 1_048_576

const canonicalSha256 = (value: string): Sha256Digest =>
  (value.startsWith('sha256:') ? value : `sha256:${value}`) as Sha256Digest

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

/**
 * Build the shared portable-context contract from the immutable Braid view.
 *
 * Provider-owned parts are either converted to an input part with an explicit
 * transformation or omitted with a reason, so the destination can verify the
 * exact content that it receives.
 */
export function canonicalPortableContextPlanForState(
  state: BraidState,
  input: {
    readonly operationId: string
    readonly branchId?: string
    readonly throughMessageId?: string
    readonly destinationRunner: string
    readonly destinationProvider?: string
    readonly destinationModel?: string
    readonly profileDigest: string
  },
): CanonicalPortableContextPlan | undefined {
  const branch = resolveBranch(state, input.branchId)
  const visible = messagesVisibleOnBranch(state, branch.id)
  if (visible.length > MAX_CANONICAL_CONTEXT_MESSAGES)
    throw new AppError('CONTEXT_TOO_LARGE', 'Canonical context has too many messages')
  const through =
    input.throughMessageId === undefined
      ? visible.at(-1)
      : visible.find((message) => message.id === input.throughMessageId)
  if (through === undefined) return undefined
  const selected = messagesThroughBoundary(visible, through.id)
  if (selected.some((message) => message.parts.length > MAX_CANONICAL_CONTEXT_PARTS))
    throw new AppError('CONTEXT_TOO_LARGE', 'Canonical context has too many parts')
  const sourceRun = sourceRunForBoundary(state, branch.id, through.id, through.runId)
  const source = sourceBoundaryForRun(sourceRun, branch.id, through.id)
  if (source === undefined) return undefined

  const sourceMessages = selected.map((message) => canonicalSourceMessage(message))
  const sourceContextMaterial = {
    source,
    completeness: sourceMessages.every((message) => message.complete)
      ? ('complete' as const)
      : ('partial' as const),
    messages: sourceMessages.map((message) => message.source),
    attachments: [],
  }
  assertCanonicalBytes(sourceContextMaterial)
  const sourceContext: PortableConversationContext = {
    ...sourceContextMaterial,
    digest: portableConversationContextDigest(sourceContextMaterial),
  }
  const destination = canonicalDestination({
    operationId: input.operationId,
    source,
    sourceDigest: sourceContext.digest,
    runner: input.destinationRunner,
    provider: input.destinationProvider ?? source.provider,
    ...(input.destinationModel === undefined ? {} : { model: input.destinationModel }),
    profileDigest: canonicalSha256(input.profileDigest),
  })

  const messages: PortableContextMessagePlan[] = []
  const outputMessages: BackendMessage[] = []
  let requiresAcceptance = sourceContext.completeness === 'partial'
  for (const message of sourceMessages) {
    const partPlans: PortableContextPartPlan[] = []
    const outputParts: InputPart[] = []
    for (const [partIndex, part] of message.source.parts.entries()) {
      const decision = canonicalPartDecision(part)
      partPlans.push(decision.plan(partIndex))
      if (decision.output !== undefined) outputParts.push(decision.output)
      if (decision.changed) requiresAcceptance = true
    }
    if (outputParts.length === 0) {
      requiresAcceptance = true
      messages.push({
        messageId: message.source.id,
        action: 'omit',
        parts: partPlans.map((part) =>
          part.action === 'omit'
            ? part
            : {
                partIndex: part.partIndex,
                action: 'omit' as const,
                reason: 'No portable input part remains',
              },
        ),
        reason: 'Provider-owned message content is not portable',
      })
      continue
    }
    const changed = partPlans.some((part) => part.action !== 'include')
    if (changed) requiresAcceptance = true
    messages.push({
      messageId: message.source.id,
      action: 'include',
      parts: partPlans,
      ...(changed ? { reason: 'Provider-owned parts were transformed or omitted' } : {}),
    })
    outputMessages.push({
      id: message.source.id,
      role: message.source.role,
      parts: outputParts,
      timestamp: message.source.timestamp,
    })
  }

  const contextMaterial = {
    source,
    completeness: requiresAcceptance ? ('partial' as const) : sourceContext.completeness,
    messages: outputMessages,
    attachments: [],
  }
  assertCanonicalBytes(contextMaterial)
  const context: PortableConversationContext = {
    ...contextMaterial,
    digest: portableConversationContextDigest(contextMaterial),
  }
  const material = {
    planId: `context-plan-${canonicalDigest({ input, source: sourceContext.digest }).slice(0, 32)}`,
    source: sourceContext,
    destination,
    messages,
    context,
    estimatedTokens: Math.ceil(Buffer.byteLength(JSON.stringify(context), 'utf8') / 4),
    requiresAcceptance,
  }
  assertCanonicalBytes(material)
  return { ...material, digest: portableContextPlanDigest(material) }
}

interface CanonicalSourceMessage {
  readonly source: BackendMessage
  readonly complete: boolean
}

function canonicalSourceMessage(message: MessageRecord): CanonicalSourceMessage {
  const parts = message.parts.map((part) => canonicalSourcePart(part))
  const fallback =
    parts.length === 0 && message.text.length > 0
      ? [{ type: 'text' as const, text: redactSensitiveText(message.text) }]
      : parts
  return {
    source: {
      id: String(message.id),
      role: message.role,
      parts: fallback,
      timestamp: safeTimestamp(message.createdAt),
    },
    complete: message.complete && message.partsTruncated !== true,
  }
}

function canonicalSourcePart(part: MessageRecord['parts'][number]): unknown {
  const text = redactSensitiveText(part.text ?? part.title ?? part.kind, 16_384)
  switch (part.kind) {
    case 'text':
      return { type: 'text', text }
    case 'artifact':
      if (part.uri === undefined)
        return { type: 'unknown', text: 'Provider artifact omitted because it has no portable URI' }
      return {
        type: 'file',
        url: redactSensitiveText(part.uri, 4_096),
        ...(part.mimeType === undefined ? {} : { mediaType: part.mimeType }),
      }
    case 'reasoning':
      return { type: 'reasoning', text }
    default:
      return { type: part.kind, text }
  }
}

function canonicalPartDecision(part: unknown): {
  readonly output?: InputPart
  readonly changed: boolean
  readonly plan: (partIndex: number) => PortableContextPartPlan
} {
  const inputPart = parseInputPart(part)
  if (inputPart !== undefined) {
    return {
      output: inputPart,
      changed: false,
      plan: (partIndex) => ({ partIndex, action: 'include' }),
    }
  }
  if (isReasoningSourcePart(part)) {
    return {
      changed: true,
      plan: (partIndex) => ({
        partIndex,
        action: 'omit',
        reason: 'Provider reasoning state is not portable',
      }),
    }
  }
  const output: InputPart = {
    type: 'text',
    text: redactSensitiveText(
      typeof part === 'object' && part !== null && 'text' in part
        ? String((part as { readonly text?: unknown }).text ?? '')
        : 'Provider part converted to portable text',
      16_384,
    ),
  }
  return {
    output,
    changed: true,
    plan: (partIndex) => ({
      partIndex,
      action: 'transform',
      output,
      reason: 'Provider part converted to portable text',
    }),
  }
}

function parseInputPart(value: unknown): InputPart | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const type = candidate.type
  if (type === 'text') {
    return typeof candidate.text === 'string' && candidate.text.length <= 16_384
      ? { type, text: candidate.text }
      : undefined
  }
  if (type === 'file' || type === 'image') {
    const allowedKeys = new Set(['type', 'filename', 'mediaType', 'url', 'path', 'content'])
    if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) return undefined
    for (const key of ['filename', 'mediaType', 'url', 'path', 'content']) {
      const entry = candidate[key]
      if (entry !== undefined && (typeof entry !== 'string' || entry.length > 16_384))
        return undefined
    }
    if (type === 'image' && candidate.content !== undefined) return undefined
    return {
      type,
      ...(typeof candidate.filename === 'string' ? { filename: candidate.filename } : {}),
      ...(typeof candidate.mediaType === 'string' ? { mediaType: candidate.mediaType } : {}),
      ...(typeof candidate.url === 'string' ? { url: candidate.url } : {}),
      ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
      ...(type === 'file' && typeof candidate.content === 'string'
        ? { content: candidate.content }
        : {}),
    }
  }
  return undefined
}

function isReasoningSourcePart(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly type?: unknown }).type === 'reasoning'
  )
}

function sourceRunForBoundary(
  state: BraidState,
  branchId: string,
  messageId: string,
  messageRunId: string | undefined,
): BraidState['runs'][number] | undefined {
  const branch = state.branches.find((candidate) => candidate.id === branchId)
  if (branch === undefined) return undefined
  const boundary = messagesVisibleOnBranch(state, branchId).find(
    (message) => message.id === messageId,
  )
  if (boundary === undefined) return undefined
  if (messageRunId !== undefined) {
    const direct = state.runs.find(
      (run) =>
        run.id === messageRunId &&
        run.conversationId === branch.conversationId &&
        run.id === boundary.runId,
    )
    if (direct !== undefined) return direct
  }
  return state.runs
    .filter(
      (run) =>
        run.conversationId === branch.conversationId &&
        run.controlRef !== undefined &&
        run.id === boundary.runId,
    )
    .at(-1)
}

function sourceBoundaryForRun(
  run: BraidState['runs'][number] | undefined,
  branchId: string,
  messageId: string,
): PortableContextSourceBoundary | undefined {
  if (run === undefined) return undefined
  const control = run.controlRef
  const provider = control?.provider ?? run.receipt.provider
  const environmentId = control?.environmentId ?? run.receipt.environmentId ?? run.environmentId
  const sessionId = control?.sessionId ?? run.providerSessionId
  const executionId = control?.executionId
  const requestDigest = control?.requestDigest ?? run.receipt.requestDigest
  if (!provider || !environmentId || !sessionId || !executionId || !requestDigest) return undefined
  return {
    runId: String(run.id),
    messageId,
    provider,
    environmentId,
    sessionId,
    executionId,
    requestDigest: canonicalSha256(requestDigest),
    branchId,
  }
}

function canonicalDestination(input: {
  readonly operationId: string
  readonly source: PortableContextSourceBoundary
  readonly sourceDigest: Sha256Digest
  readonly runner: string
  readonly provider: string
  readonly model?: string
  readonly profileDigest: Sha256Digest
}): PortableContextDestination {
  const suffix = canonicalDigest({
    operationId: input.operationId,
    source: input.source,
    sourceDigest: input.sourceDigest,
    runner: input.runner,
    provider: input.provider,
    model: input.model ?? null,
  }).slice(0, 32)
  return {
    runner: input.runner,
    provider: input.provider,
    environmentId: `environment-handoff-${suffix}`,
    sessionId: `session-handoff-${suffix}`,
    runId: `run-handoff-${suffix}`,
    executionId: `execution-handoff-${suffix}`,
    ...(input.model === undefined ? {} : { model: input.model }),
    profileDigest: input.profileDigest,
  }
}

function safeTimestamp(value: string): string {
  return Number.isFinite(Date.parse(value)) ? value : new Date(0).toISOString()
}

function assertCanonicalBytes(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CANONICAL_PLAN_BYTES)
    throw new AppError('CONTEXT_TOO_LARGE', 'Canonical context exceeds the one-megabyte limit')
}
