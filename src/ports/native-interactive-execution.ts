import type { RetainedInteractiveRunHandle } from '@tangle-network/agent-runtime/kernel'

export type NativeInteractiveRunOutcome =
  | { readonly kind: 'detached' }
  | { readonly kind: 'exited'; readonly exitCode?: number; readonly exitSignal?: string }
  | { readonly kind: 'failed'; readonly message: string }

/** Rendezvous between Braid's durable run and the terminal-only native viewer. */
export interface NativeInteractiveExecutionControl {
  readonly delegation?: 'offer' | undefined
  waitForHandle(
    runId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RetainedInteractiveRunHandle>
  settle(runId: string, outcome: NativeInteractiveRunOutcome): void
}
