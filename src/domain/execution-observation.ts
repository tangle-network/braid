export type ObservedEnvironmentLifecycle =
  | 'requested'
  | 'creating'
  | 'ready'
  | 'detached'
  | 'expired'
  | 'failed'
  | 'destroying'
  | 'destroyed'
  | 'unknown'

export interface EnvironmentResourceRequest {
  readonly cpuCores?: number
  readonly memoryMB?: number
  readonly diskGB?: number
  readonly accelerator?: {
    readonly kind: string
    readonly count: number
    readonly memoryMB?: number
  }
}

export interface EnvironmentResourceSample {
  readonly cgroupVersion: number
  readonly memoryCurrentMb: number
  readonly memoryPeakMb?: number
  readonly memoryLimitMb?: number
  readonly cpuUsageUsec: number
  readonly sampledAt: string
}

export interface EnvironmentGpuObservation {
  readonly provider: string
  readonly instanceType?: string
  readonly region?: string
  readonly accelerator: string
  readonly count: number
  readonly status: string
  readonly customerPricePerHourUsd?: number
  readonly estimatedCustomerCostUsd?: number
  readonly billedSeconds?: number
  readonly billedCustomerCostUsd?: number
}

export interface SandboxAccountObservation {
  readonly scope: 'account'
  readonly completeness: 'provider-reported-possibly-defaulted'
  readonly customerId?: string
  readonly billingOwnerId?: string
  readonly computeMinutes?: number
  readonly gpuSeconds?: number
  readonly gpuCostUsd?: number
  readonly activeSandboxes?: number
  readonly totalSandboxes?: number
  readonly creditsAvailableUsd?: number
  readonly creditsUsedUsd?: number
  readonly monthlyBalanceUsd?: number
  readonly plan?: string
  readonly subscriptionStatus?: string
  readonly maximumConcurrentSandboxes?: number
  readonly maximumCpuCores?: number
  readonly maximumRamGB?: number
  readonly maximumStorageGB?: number
  readonly usagePeriodStart?: string
  readonly usagePeriodEnd?: string
  readonly subscriptionPeriodEnd?: string
  readonly sampledAt: string
}

/** Secret-free execution facts captured from the provider SDK. */
export interface ExecutionEnvironmentObservation {
  readonly kind: 'local-process' | 'remote-service' | 'sandbox'
  readonly provider: string
  readonly providerEnvironmentId?: string
  readonly name?: string
  readonly lifecycle: ObservedEnvironmentLifecycle
  readonly lifecycleMode: 'request' | 'ephemeral' | 'retained'
  readonly cleanup: 'delete-after-turn' | 'explicit' | 'not-applicable'
  readonly continuity: 'session' | 'unavailable' | 'not-applicable'
  readonly location: 'local' | 'remote' | 'unknown'
  /** Hostname of the configured or public endpoint, never a URL or credential. */
  readonly runtimeEndpointHost?: string
  readonly machineId?: string
  readonly requestedRegion?: string
  readonly region?: string
  readonly storagePersistence?: 'ephemeral-home' | 'persistent-home' | 'unknown'
  readonly requestedResources?: EnvironmentResourceRequest
  readonly resourceSample?: EnvironmentResourceSample
  readonly gpu?: EnvironmentGpuObservation
  readonly account?: SandboxAccountObservation
  readonly createdAt: string
  readonly startedAt?: string
  readonly lastActivityAt?: string
  readonly expiresAt?: string
  readonly observedAt: string
  readonly unavailable: readonly string[]
}
