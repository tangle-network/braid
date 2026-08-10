import type { SandboxClientLike, SandboxInstanceLike } from '@tangle-network/agent-provider-tangle'
import type {
  GpuLease,
  SandboxConnection,
  SandboxIdentity,
  SandboxResourceUsage,
  SubscriptionInfo,
  UsageInfo,
} from '@tangle-network/sandbox'
import type {
  EnvironmentGpuObservation,
  EnvironmentResourceRequest,
  ExecutionEnvironmentObservation,
  ObservedEnvironmentLifecycle,
  SandboxAccountObservation,
} from '../../domain/execution-observation.js'

export interface ObservableSandboxClient extends SandboxClientLike {
  getIdentity?(): Promise<SandboxIdentity>
  usage?(): Promise<UsageInfo>
  subscription?(): Promise<SubscriptionInfo>
}

export interface ObservableSandboxInstance extends SandboxInstanceLike {
  readonly connection?: SandboxConnection
  readonly createdAt?: Date | string
  readonly startedAt?: Date | string
  readonly lastActivityAt?: Date | string
  readonly expiresAt?: Date | string
  readonly gpuLease?: GpuLease
  resourceUsage?(): Promise<SandboxResourceUsage | null>
}

export interface MutableSandboxObservation {
  providerEnvironmentId?: string | undefined
  name?: string | undefined
  lifecycle: ObservedEnvironmentLifecycle
  runtimeEndpointHost?: string | undefined
  machineId?: string | undefined
  requestedRegion?: string | undefined
  region?: string | undefined
  storagePersistence?: ExecutionEnvironmentObservation['storagePersistence'] | undefined
  requestedResources?: EnvironmentResourceRequest | undefined
  resourceSample?: ExecutionEnvironmentObservation['resourceSample'] | undefined
  gpu?: EnvironmentGpuObservation | undefined
  account?: SandboxAccountObservation | undefined
  createdAt: string
  startedAt?: string | undefined
  lastActivityAt?: string | undefined
  expiresAt?: string | undefined
}

export function boundedObservationText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const candidate = value.trim()
  return candidate.length > 0 && candidate.length <= 512 ? candidate : undefined
}

export function observationRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function positiveObservationNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function observationDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined
}

export function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      () => {
        clearTimeout(timeout)
        resolve(undefined)
      },
    )
  })
}

export function completesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs)
    promise.then(
      () => {
        clearTimeout(timeout)
        resolve(true)
      },
      () => {
        clearTimeout(timeout)
        resolve(false)
      },
    )
  })
}
