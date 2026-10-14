import type {
  AgentProfile,
  ContextTransferRequest,
  ContextTransferResult,
} from '@tangle-network/agent-interface'
import { defineAgentProfile } from '@tangle-network/agent-interface/profile'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecutionPort,
  type RunCapabilities,
} from '../ports/execution.js'

const capturedAt = '2026-10-14T00:00:00.000Z'
const SOURCE_PROVIDER = 'fixture-provider'
const SOURCE_ENVIRONMENT = 'fixture-source-environment'
const SOURCE_SESSION = 'session-fixture-source'

/** A second trusted catalog profile for the offline profile-handoff walkthrough. */
export const PROFILE_HANDOFF_REVIEWER: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Review engineer',
  description: 'Reviews a change and reports each risk with its evidence',
  version: '1.0.0',
  tags: ['coding', 'review'],
  harness: 'pi',
  model: {
    default: 'openai-codex/gpt-5.6-luna',
    provider: 'openai-codex',
    reasoningEffort: 'high',
  },
  prompt: { instructions: ['Review the change and cite the evidence for every risk.'] },
  tools: { read: true, write: false, shell: true },
  permissions: { read: 'allow', write: 'deny', shell: 'ask' },
})

function capabilities(): RunCapabilities {
  return {
    ...DEFAULT_RUN_CAPABILITIES,
    streaming: { ...DEFAULT_RUN_CAPABILITIES.streaming, replay: true },
    sessions: { continue: true, messages: true },
    events: { stableIdentity: true, sequence: true, cursor: true },
  } as RunCapabilities
}

function acceptedTransfer(request: ContextTransferRequest): ContextTransferResult {
  const plan = request.plan
  return {
    status: 'accepted',
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    planDigest: plan.digest,
    contextDigest: plan.context.digest,
    source: plan.source.source,
    destination: plan.destination,
    provider: plan.destination.provider,
    environmentId: plan.destination.environmentId ?? 'fixture-destination-environment',
    sessionId: plan.destination.sessionId,
    runId: plan.destination.runId,
    executionId: plan.destination.executionId,
    sessionCreatedForOperationId: request.operationId,
    sessionCreatedAt: capturedAt,
    transferredMessageIds: plan.messages
      .filter((message) => message.action === 'include')
      .map((message) => message.messageId),
    omittedMessageIds: plan.messages
      .filter((message) => message.action === 'omit')
      .map((message) => message.messageId),
    admittedAt: capturedAt,
  }
}

/**
 * Offline execution with exact, retry-safe context transfer.
 *
 * Each answer names the AgentProfile Braid admitted, so the walkthrough shows
 * which profile ran. It is a local fixture, not provider evidence.
 */
export function createProfileHandoffFixture(): ExecutionPort {
  const transfers = new Map<string, ContextTransferResult>()
  // Later turns on a destination branch continue the session the transfer created.
  const destinationSessions = new Map<string, ContextTransferResult>()
  const destinationFor = (input: { readonly sessionId?: string }) =>
    input.sessionId === undefined ? undefined : destinationSessions.get(input.sessionId)
  return {
    admissionMode: 'sync',
    capabilities: () => capabilities(),
    admit(input) {
      const destination = input.contextTransferReceipt ?? destinationFor(input)
      const accepted = destination?.status === 'accepted' ? destination : undefined
      const provider = accepted?.provider ?? SOURCE_PROVIDER
      return {
        capabilities: capabilities(),
        provider,
        environmentId: accepted?.environmentId ?? SOURCE_ENVIRONMENT,
        providerSessionId:
          input.contextTransfer?.plan.destination.sessionId ?? input.sessionId ?? SOURCE_SESSION,
        materializationReceipt: { provider },
      }
    },
    async *streamTurn(input) {
      if (
        input.contextTransfer === undefined &&
        input.contextTransferReceipt === undefined &&
        destinationFor(input) === undefined
      ) {
        yield {
          type: 'braid.execution.observed',
          observation: {
            kind: 'sandbox',
            provider: SOURCE_PROVIDER,
            providerEnvironmentId: SOURCE_ENVIRONMENT,
            lifecycle: 'ready',
            lifecycleMode: 'retained',
            cleanup: 'explicit',
            continuity: 'session',
            location: 'remote',
            createdAt: capturedAt,
            startedAt: capturedAt,
            lastActivityAt: capturedAt,
            observedAt: capturedAt,
            unavailable: [],
          },
          controlRef: {
            runId: input.runId,
            provider: SOURCE_PROVIDER,
            environmentId: SOURCE_ENVIRONMENT,
            sessionId: SOURCE_SESSION,
            executionId: `execution-${input.runId}`,
            requestDigest: `sha256:${'f'.repeat(64)}`,
          },
          timestamp: capturedAt,
        }
      }
      const copied = input.contextTransfer?.plan.messages.filter(
        (message) => message.action === 'include',
      ).length
      const name = input.profile.name ?? 'Unnamed profile'
      yield {
        type: 'final',
        status: 'completed',
        reason: 'completed',
        text:
          copied === undefined
            ? `${name} answered: ${input.text}`
            : `${name} answered with ${copied} copied messages: ${input.text}`,
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: `task-${input.runId}`, intent: input.text },
        timestamp: capturedAt,
      }
    },
    context: {
      async supports() {
        return true
      },
      async lookup(request) {
        return transfers.get(request.operationId)
      },
      async transfer(request) {
        const result = acceptedTransfer(request)
        transfers.set(request.operationId, result)
        if (result.status === 'accepted') destinationSessions.set(result.sessionId, result)
        return result
      },
    },
  }
}
