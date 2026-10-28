import {
  type AgentInteractiveSessionControlClaim,
  type AgentInteractiveSessionPromptAcknowledgement,
  type AgentInteractiveSessionRef,
  type AgentInteractiveSessionStart,
  AgentInteractiveSessionRefSchema,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentProvider,
} from '@tangle-network/agent-interface/environment-provider'

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

const capabilities: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: true,
    systemPrompt: { replace: true, append: true },
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: { files: true, instructions: true },
    runtimeUpdate: true,
    validation: true,
  },
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, list: true, messages: true },
  workspace: { read: true, write: true, exec: true, git: true, upload: true, download: true },
  branching: { checkpoint: true, fork: true },
  placement: true,
  usage: true,
  confidential: false,
  interactiveAgent: {
    start: true,
    control: true,
    status: true,
    attach: true,
    reattach: true,
    sendPrompt: true,
    input: true,
    resize: true,
    stop: true,
  },
}

/**
 * One provider-owned coding-agent process with the Sandbox's exact control semantics: a
 * compare-and-swap control generation, and a prompt ledger that replays a held operation id and
 * refuses the same id with different material. Every `AgentEnvironmentProvider` built from one
 * instance reaches the same process, as two Braid processes reach one Sandbox.
 */
export class InteractiveEnvironmentFixture {
  readonly prompts: string[] = []
  creates = 0
  #ref: AgentInteractiveSessionRef | undefined
  #generation = 0
  #running = true
  readonly #promptLedger = new Map<string, AgentInteractiveSessionPromptAcknowledgement>()
  readonly #environmentId = 'interactive-fixture-environment'

  provider(): AgentEnvironmentProvider {
    const environment = this.#environment()
    return {
      name: 'tangle-sandbox',
      capabilities: async () => capabilities,
      create: async () => {
        this.creates += 1
        return environment
      },
      get: async (id) => (id === this.#environmentId ? environment : null),
    }
  }

  #control(ref: AgentInteractiveSessionRef): AgentInteractiveSessionControlClaim {
    return {
      refDigest: canonicalCandidateDigest(ref),
      generation: this.#generation,
      leaseId: `interactive-lease-${this.#generation}`,
      holderId: 'braid',
      expiresAt: '2126-08-16T00:00:00.000Z',
    }
  }

  #environment(): AgentEnvironment {
    const fixture = this
    return {
      id: this.#environmentId,
      provider: 'tangle-sandbox',
      status: async () => 'running',
      async *stream() {},
      dispatch: async () => {
        throw new Error('an interactive run never dispatches a headless turn')
      },
      startInteractive: async (request: AgentInteractiveSessionStart) => {
        fixture.#ref ??= AgentInteractiveSessionRefSchema.parse({
          run: request.run,
          preparationReceipt: preparationReceipt(request),
          incarnationId: 'interactive-fixture-incarnation',
          startedAt: '2026-10-28T00:00:00.000Z',
        })
        return fixture.#ref
      },
      interactive: () => {
        const ref = fixture.#ref
        if (ref === undefined) throw new Error('the interactive process has not started')
        return {
          ref,
          claimControl: async (request, options) => {
            options?.signal?.throwIfAborted()
            if (request.expectedGeneration !== fixture.#generation) {
              return {
                operationId: request.operationId,
                requestDigest: request.requestDigest,
                ref,
                status: 'conflict' as const,
                conflictReason: 'generation_mismatch' as const,
                currentGeneration: fixture.#generation,
              }
            }
            fixture.#generation += 1
            return {
              operationId: request.operationId,
              requestDigest: request.requestDigest,
              ref,
              status: 'accepted' as const,
              control: fixture.#control(ref),
            }
          },
          status: async () =>
            fixture.#running
              ? { state: 'running' as const, ref }
              : {
                  state: 'exited' as const,
                  ref,
                  endedAt: '2026-10-28T00:05:00.000Z',
                  reason: 'stopped' as const,
                },
          attach: async () => {
            throw new Error('the steer proof attaches no terminal')
          },
          sendPrompt: async (command, options) => {
            options?.signal?.throwIfAborted()
            const held = fixture.#promptLedger.get(command.operationId)
            if (held !== undefined) {
              return held.requestDigest === command.requestDigest
                ? { ...held, control: command.control, status: 'replayed' as const }
                : {
                    operationId: command.operationId,
                    requestDigest: command.requestDigest,
                    ref,
                    control: command.control,
                    status: 'conflict' as const,
                    existingRequestDigest: held.requestDigest,
                  }
            }
            if (command.control.generation !== fixture.#generation) {
              throw new Error('Interactive control claim is stale')
            }
            const acknowledgement = {
              operationId: command.operationId,
              requestDigest: command.requestDigest,
              ref,
              control: command.control,
              status: 'accepted' as const,
            }
            fixture.#promptLedger.set(command.operationId, acknowledgement)
            fixture.prompts.push(command.prompt)
            return acknowledgement
          },
          stop: async (command) => {
            fixture.#running = false
            return {
              operationId: command.operationId,
              requestDigest: command.requestDigest,
              ref,
              control: command.control,
              status: 'accepted' as const,
              effect: 'stopped' as const,
            }
          },
        }
      },
      destroy: async () => {},
    }
  }
}

function preparationReceipt(request: AgentInteractiveSessionStart) {
  const receipt = {
    kind: 'agent-execution-preparation' as const,
    schemaVersion: 1 as const,
    preparationId: 'interactive-fixture-preparation',
    requestDigest: request.run.requestDigest,
    authoredProfileDigest: request.requestedProfileDigest,
    effectiveProfileDigest: request.requestedProfileDigest,
    backend: 'test-backend',
    harness: request.profile.harness,
    harnessVersion: 'test-harness-1',
    resolvedModel: {
      requested: request.profile.model?.default ?? 'test-model',
      resolved: request.profile.model?.default ?? 'test-model',
    },
    workspace: {
      leaseId: 'interactive-fixture-workspace-lease',
      provider: 'tangle-sandbox',
      identityDigest: digest('2'),
      isolation: 'per-run' as const,
      sourceSnapshotDigest: digest('3'),
      sourceSnapshotPolicy: {
        kind: 'provider-declared' as const,
        name: 'test-snapshot',
        version: 1,
        digest: digest('4'),
      },
      preparedWorkspaceDigest: digest('5'),
      profileActivationDigest: digest('6'),
    },
    axisResults: [],
    executionPlanDigest: digest('7'),
    materializer: { name: 'test-materializer', version: '1' },
    expiresAtMs: 4102444800000,
  }
  return { ...receipt, digest: canonicalCandidateDigest(receipt) }
}
