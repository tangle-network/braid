import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigestHex,
  snapshotAgentProfile,
} from '../adapters/agent-interface/profile-runtime.js'
import { canonicalDigest } from './canonical.js'
import { publicMaterializationReceipt } from './materialization-receipt.js'
import { redactProfile, redactSensitiveText, redactStructuredValue } from './redaction.js'
import type {
  ContextTransferReceipt,
  NativeContextBoundaryProof,
  PortableAnalysisAttachment,
  PortableContextMessage,
  PortableContextPlan,
  RequestedInteractions,
  RunAdmissionReceipt,
  RunCapabilities,
} from './run-contracts.js'

export type {
  ContextTransferReceipt,
  NativeContextBoundaryProof,
  PortableAnalysisAttachment,
  PortableContextMessage,
  PortableContextPart,
  PortableContextPlan,
  RequestedInteractions,
  RunAdmissionReceipt,
  RunCapabilities,
  RunControlCapabilities,
  RunEventCapabilities,
} from './run-contracts.js'

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const SENSITIVE_VALUE =
  /(?:password|passphrase|token|secret|credential|authorization|bearer|api[_-]?key|private[_-]?key|cookie|header|query|fragment)s*[:=]/iu

function safeProviderIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const candidate = value.trim()
  return SAFE_IDENTIFIER.test(candidate) && !SENSITIVE_VALUE.test(candidate) ? candidate : undefined
}

function safeProviderWarning(value: unknown): string {
  if (typeof value !== 'string') return 'PROVIDER_WARNING'
  const candidate = redactSensitiveText(value).trim()
  return /^[A-Z][A-Z0-9]*(?:[._][A-Z0-9]+)*$/u.test(candidate) && !SENSITIVE_VALUE.test(candidate)
    ? candidate
    : 'PROVIDER_WARNING'
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

function utf8Prefix(value: string, bytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= bytes) return value
  let output = ''
  let used = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > bytes) break
    output += character
    used += size
  }
  return output
}

function boundedWarnings(warnings: readonly string[] | undefined): readonly string[] | undefined {
  if (warnings === undefined) return undefined
  const output: string[] = []
  let bytes = 0
  for (const warning of warnings.slice(0, 64)) {
    const bounded = utf8Prefix(safeProviderWarning(warning), 4096)
    const size = Buffer.byteLength(bounded, 'utf8')
    if (bytes + size > 64 * 1024) break
    output.push(bounded)
    bytes += size
  }
  return output
}

export function createPortableContextPlan(input: {
  readonly sourceRunId: string
  readonly sourceBoundary: string
  readonly destinationRunner?: string
  readonly messages: readonly PortableContextMessage[]
  readonly analysisAttachments?: readonly PortableAnalysisAttachment[]
  readonly omittedPartIds?: readonly string[]
  readonly transformedPartIds?: readonly string[]
  readonly complete?: boolean
  readonly tokenEstimate?: number
}): PortableContextPlan {
  const plan = {
    sourceRunId: input.sourceRunId,
    sourceBoundary: input.sourceBoundary,
    ...(input.destinationRunner === undefined
      ? {}
      : { destinationRunner: input.destinationRunner }),
    messages: input.messages,
    ...(input.analysisAttachments === undefined
      ? {}
      : { analysisAttachments: input.analysisAttachments }),
    omittedPartIds: input.omittedPartIds ?? [],
    transformedPartIds: input.transformedPartIds ?? [],
    complete: input.complete ?? true,
    ...(input.tokenEstimate === undefined ? {} : { tokenEstimate: input.tokenEstimate }),
  }
  return freezeDeep({ ...structuredClone(plan), digest: canonicalDigest(plan) })
}

export function createAdmissionReceipt(input: {
  readonly runId: string
  readonly turnId: string
  readonly operationId: string
  readonly conversationId: string
  readonly branchId: string
  readonly admittedAt: string
  readonly profile: Readonly<AgentProfile>
  readonly connectionId?: string
  readonly mode?: string
  readonly interactions?: RequestedInteractions
  readonly text: string
  readonly sessionId?: string
  readonly capabilities: RunCapabilities
  readonly provider?: string
  readonly environmentId?: string
  readonly providerSessionId?: string
  readonly materializationReceipt?: Readonly<Record<string, unknown>>
  readonly contextPlan?: PortableContextPlan
  readonly contextPlanDigest?: string
  readonly contextTransfer?: ContextTransferReceipt
  readonly nativeContextBoundaryProof?: NativeContextBoundaryProof
  readonly warnings?: readonly string[]
  readonly admissionStatus?: 'admitted' | 'pending' | 'unavailable'
}): RunAdmissionReceipt {
  const exactProfile = snapshotAgentProfile(input.profile)
  const profileDigest = canonicalAgentProfileDigestHex(exactProfile)
  const profile = redactProfile(exactProfile)
  const text = redactSensitiveText(input.text)
  const capabilities = redactStructuredValue(input.capabilities, undefined, {
    maxDepth: 6,
    maxItems: 128,
    maxBytes: 32 * 1024,
  }) as RunCapabilities
  const materializationReceipt =
    input.materializationReceipt === undefined
      ? undefined
      : publicMaterializationReceipt(input.materializationReceipt)
  const warnings = boundedWarnings(input.warnings)
  const contextPlanDigest = input.contextPlanDigest ?? input.contextTransfer?.planDigest
  const requested = {
    text,
    profile: structuredClone(profile),
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.interactions === undefined ? {} : { interactions: input.interactions }),
    ...(profile.model?.default === undefined ? {} : { model: profile.model.default }),
    ...(profile.harness === undefined ? {} : { runner: profile.harness }),
    ...(contextPlanDigest === undefined ? {} : { contextPlanDigest }),
  }
  const requestDigest = canonicalDigest({
    runId: input.runId,
    turnId: input.turnId,
    operationId: input.operationId,
    conversationId: input.conversationId,
    branchId: input.branchId,
    text,
    profileDigest,
    connectionId: input.connectionId ?? null,
    mode: input.mode ?? null,
    interactions: input.interactions ?? {},
    contextPlanDigest: contextPlanDigest ?? null,
  })
  const capabilitiesDigest = canonicalDigest(capabilities)
  const materializationDigest =
    materializationReceipt === undefined ? undefined : canonicalDigest(materializationReceipt)
  const provider = safeProviderIdentifier(input.provider)
  const requestedSessionId = safeProviderIdentifier(input.sessionId)
  const environmentId = safeProviderIdentifier(input.environmentId)
  const providerSessionId = safeProviderIdentifier(input.providerSessionId)
  const base = {
    version: 1 as const,
    runId: input.runId,
    turnId: input.turnId,
    operationId: input.operationId,
    conversationId: input.conversationId,
    branchId: input.branchId,
    admittedAt: input.admittedAt,
    profileDigest,
    requested,
    capabilities: structuredClone(capabilities),
    ...(provider === undefined ? {} : { provider }),
    ...(requestedSessionId === undefined ? {} : { requestedSessionId }),
    ...(environmentId === undefined ? {} : { environmentId }),
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    ...(materializationReceipt === undefined
      ? {}
      : {
          materializationReceipt,
        }),
    ...(input.contextTransfer === undefined
      ? {}
      : {
          contextTransfer: redactStructuredValue(input.contextTransfer, undefined, {
            maxDepth: 4,
            maxItems: 32,
            maxBytes: 16 * 1024,
          }) as typeof input.contextTransfer,
        }),
    ...(input.nativeContextBoundaryProof === undefined
      ? {}
      : {
          nativeContextBoundaryProof: redactStructuredValue(
            input.nativeContextBoundaryProof,
            undefined,
            {
              maxDepth: 4,
              maxItems: 32,
              maxBytes: 16 * 1024,
            },
          ) as typeof input.nativeContextBoundaryProof,
        }),
    ...(warnings === undefined ? {} : { warnings }),
    admissionStatus: input.admissionStatus ?? 'admitted',
    requestDigest,
    capabilitiesDigest,
    ...(materializationDigest === undefined ? {} : { materializationDigest }),
  }
  return freezeDeep({ ...base, digest: canonicalDigest(base) })
}
