import type { RetainedInteractiveRunHandle } from '@tangle-network/agent-runtime/kernel'

export interface NativeWorkerAttachRequest {
  readonly operationId: string
  readonly supervisorId: string
  readonly workerId: string
}

export type NativeWorkerAttachResult =
  | { readonly status: 'available'; readonly handle: RetainedInteractiveRunHandle }
  | { readonly status: 'unavailable'; readonly reason: string }

export interface NativeWorkerAttachAvailability {
  readonly available: boolean
  readonly reason?: string
}

/** Resolves one Runtime-owned worker process for the native terminal viewer. */
export interface NativeWorkerAttachPort {
  availability?(): NativeWorkerAttachAvailability
  attach(request: NativeWorkerAttachRequest): Promise<NativeWorkerAttachResult>
}
