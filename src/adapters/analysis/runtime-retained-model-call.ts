import type { AgentExactRunControlRef, AgentProfile } from '@tangle-network/agent-interface'
import type { AgentTurnResult } from '@tangle-network/agent-interface/environment-provider'
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'
import { startRetainedRun } from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import type { RetainedRunAdmissionRecorder } from '../../domain/run-contracts.js'

export interface RetainedModelCallInput {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly profile: Readonly<AgentProfile>
  readonly model: string
  readonly messages: ReadonlyArray<Readonly<{ role: string; content: string }>>
  readonly callId: string
  readonly signal: AbortSignal
  readonly onAdmission: RetainedRunAdmissionRecorder
}

export interface RetainedModelCallResult {
  readonly result: AgentTurnResult
  readonly controlRef: AgentExactRunControlRef
}

export class RetainedModelCallError extends Error {
  readonly controlRef: AgentExactRunControlRef

  constructor(controlRef: AgentExactRunControlRef, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Retained CLI Bridge model call failed', {
      cause,
    })
    this.name = 'RetainedModelCallError'
    this.controlRef = controlRef
  }
}

/** Execute one analyst request through the same retained CLI Bridge path as a Braid turn. */
export async function runRetainedCliBridgeModelCall(
  input: RetainedModelCallInput,
): Promise<RetainedModelCallResult> {
  input.signal.throwIfAborted()
  const digest = String(
    canonicalDigest({
      callId: input.callId,
      messages: input.messages,
      model: input.model,
      profile: input.profile,
    }),
  )
  const provider = createCliBridgeProvider({
    baseUrl: input.baseUrl,
    bearerToken: input.bearerToken,
    defaultModel: input.model,
    fetch: globalThis.fetch,
  })
  const handle = await startRetainedRun({
    provider,
    environment: {
      profile: input.profile,
      ...(input.profile.harness === undefined ? {} : { backend: input.profile.harness }),
      idempotencyKey: `analysis-environment-${digest}`,
    },
    turn: {
      prompt: JSON.stringify({ messages: input.messages }),
      turnId: `analysis-turn-${digest}`,
      signal: input.signal,
    },
    identity: {
      sessionId: `analysis-session-${digest}`,
      executionId: `analysis-${digest}`,
    },
    onAdmission: input.onAdmission,
  })
  try {
    return {
      result: await resultWithCancellation(handle, input.signal, digest),
      controlRef: handle.controlRef,
    }
  } catch (error) {
    throw new RetainedModelCallError(handle.controlRef, error)
  }
}

async function resultWithCancellation(
  handle: Awaited<ReturnType<typeof startRetainedRun>>,
  signal: AbortSignal,
  digest: string,
): Promise<AgentTurnResult> {
  if (signal.aborted) {
    await handle.cancel({ operationId: `analysis-cancel-${digest}` })
    signal.throwIfAborted()
  }
  return new Promise<AgentTurnResult>((resolve, reject) => {
    let settled = false
    let settling = false
    const beginSettlement = (): boolean => {
      if (settled || settling) return false
      settling = true
      return true
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const rejectAfterCancellation = (reason: unknown, message: string): void => {
      if (!beginSettlement()) return
      void handle.cancel({ operationId: `analysis-cancel-${digest}` }).then(
        () => finish(() => reject(reason)),
        (cancellationError: unknown) =>
          finish(() => reject(new AggregateError([reason, cancellationError], message))),
      )
    }
    const onAbort = (): void => {
      rejectAfterCancellation(signal.reason, 'Trace analysis cancellation was not confirmed')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void handle.result().then(
      (result) => {
        if (!beginSettlement()) return
        finish(() => resolve(result))
      },
      (error: unknown) =>
        rejectAfterCancellation(
          error,
          'Trace analysis failed and retained-run cancellation was not confirmed',
        ),
    )
  })
}
