import type { EnvironmentRecord } from '../../domain/entities.js'
import type { EnvironmentView } from './models.js'
import { sanitizeTerminalText } from './sanitize.js'

export function environmentView(record: EnvironmentRecord): EnvironmentView {
  return {
    id: String(record.id),
    connectionId: String(record.connectionId),
    ...(record.kind === undefined ? {} : { kind: record.kind }),
    provider: safe(record.placement.provider),
    ...(record.providerEnvironmentId === undefined
      ? {}
      : { providerEnvironmentId: safe(record.providerEnvironmentId) }),
    lifecycle: record.lifecycle,
    ...(record.lifecycleMode === undefined ? {} : { lifecycleMode: record.lifecycleMode }),
    ...(record.cleanup === undefined ? {} : { cleanup: record.cleanup }),
    ...(record.continuity === undefined ? {} : { continuity: record.continuity }),
    ...(record.location === undefined ? {} : { location: record.location }),
    ...(record.runtimeEndpointHost === undefined
      ? {}
      : { runtimeEndpointHost: safe(record.runtimeEndpointHost) }),
    ...(record.machineId === undefined ? {} : { machineId: safe(record.machineId) }),
    ...(record.requestedRegion === undefined
      ? {}
      : { requestedRegion: safe(record.requestedRegion) }),
    ...(record.placement.region === undefined
      ? {}
      : { verifiedRegion: safe(record.placement.region) }),
    ...(record.storagePersistence === undefined
      ? {}
      : { storagePersistence: record.storagePersistence }),
    ...(record.requestedResources === undefined
      ? {}
      : {
          requestedResources: {
            ...(record.requestedResources.cpuCores === undefined
              ? {}
              : { cpuCores: record.requestedResources.cpuCores }),
            ...(record.requestedResources.memoryMB === undefined
              ? {}
              : { memoryMB: record.requestedResources.memoryMB }),
            ...(record.requestedResources.diskGB === undefined
              ? {}
              : { diskGB: record.requestedResources.diskGB }),
            ...(record.requestedResources.accelerator === undefined
              ? {}
              : {
                  accelerator: {
                    ...record.requestedResources.accelerator,
                    kind: safe(record.requestedResources.accelerator.kind),
                  },
                }),
          },
        }),
    ...(record.resourceSample === undefined
      ? {}
      : {
          resourceSample: {
            cgroupVersion: record.resourceSample.cgroupVersion,
            memoryCurrentMb: record.resourceSample.memoryCurrentMb,
            ...(record.resourceSample.memoryPeakMb === undefined
              ? {}
              : { memoryPeakMb: record.resourceSample.memoryPeakMb }),
            ...(record.resourceSample.memoryLimitMb === undefined
              ? {}
              : { memoryLimitMb: record.resourceSample.memoryLimitMb }),
            cpuUsageUsec: record.resourceSample.cpuUsageUsec,
            sampledAt: record.resourceSample.sampledAt,
          },
        }),
    ...(record.gpu === undefined
      ? {}
      : {
          gpu: {
            ...record.gpu,
            provider: safe(record.gpu.provider),
            ...(record.gpu.instanceType === undefined
              ? {}
              : { instanceType: safe(record.gpu.instanceType) }),
            ...(record.gpu.region === undefined ? {} : { region: safe(record.gpu.region) }),
            accelerator: safe(record.gpu.accelerator),
            status: safe(record.gpu.status),
          },
        }),
    ...(record.accountUsage === undefined
      ? {}
      : {
          accountUsage: {
            completeness: record.accountUsage.completeness,
            ...(record.accountUsage.customerId === undefined
              ? {}
              : { customerId: safe(record.accountUsage.customerId) }),
            ...(record.accountUsage.billingOwnerId === undefined
              ? {}
              : { billingOwnerId: safe(record.accountUsage.billingOwnerId) }),
            ...(record.accountUsage.computeMinutes === undefined
              ? {}
              : { computeMinutes: record.accountUsage.computeMinutes }),
            ...(record.accountUsage.gpuSeconds === undefined
              ? {}
              : { gpuSeconds: record.accountUsage.gpuSeconds }),
            ...(record.accountUsage.gpuCostUsd === undefined
              ? {}
              : { gpuCostUsd: record.accountUsage.gpuCostUsd }),
            ...(record.accountUsage.activeSandboxes === undefined
              ? {}
              : { activeSandboxes: record.accountUsage.activeSandboxes }),
            ...(record.accountUsage.totalSandboxes === undefined
              ? {}
              : { totalSandboxes: record.accountUsage.totalSandboxes }),
            ...(record.accountUsage.creditsAvailableUsd === undefined
              ? {}
              : { creditsAvailableUsd: record.accountUsage.creditsAvailableUsd }),
            ...(record.accountUsage.creditsUsedUsd === undefined
              ? {}
              : { creditsUsedUsd: record.accountUsage.creditsUsedUsd }),
            ...(record.accountUsage.monthlyBalanceUsd === undefined
              ? {}
              : { monthlyBalanceUsd: record.accountUsage.monthlyBalanceUsd }),
            ...(record.accountUsage.plan === undefined
              ? {}
              : { plan: safe(record.accountUsage.plan) }),
            ...(record.accountUsage.subscriptionStatus === undefined
              ? {}
              : { subscriptionStatus: safe(record.accountUsage.subscriptionStatus) }),
            ...(record.accountUsage.maximumConcurrentSandboxes === undefined
              ? {}
              : {
                  maximumConcurrentSandboxes: record.accountUsage.maximumConcurrentSandboxes,
                }),
            ...(record.accountUsage.maximumCpuCores === undefined
              ? {}
              : { maximumCpuCores: record.accountUsage.maximumCpuCores }),
            ...(record.accountUsage.maximumRamGB === undefined
              ? {}
              : { maximumRamGB: record.accountUsage.maximumRamGB }),
            ...(record.accountUsage.maximumStorageGB === undefined
              ? {}
              : { maximumStorageGB: record.accountUsage.maximumStorageGB }),
            ...(record.accountUsage.usagePeriodStart === undefined
              ? {}
              : { usagePeriodStart: record.accountUsage.usagePeriodStart }),
            ...(record.accountUsage.usagePeriodEnd === undefined
              ? {}
              : { usagePeriodEnd: record.accountUsage.usagePeriodEnd }),
            ...(record.accountUsage.subscriptionPeriodEnd === undefined
              ? {}
              : { subscriptionPeriodEnd: record.accountUsage.subscriptionPeriodEnd }),
            sampledAt: record.accountUsage.sampledAt,
          },
        }),
    unavailableTelemetry: (record.unavailableTelemetry ?? []).map(safe),
    createdAt: record.createdAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.lastActivityAt === undefined ? {} : { lastActivityAt: record.lastActivityAt }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    updatedAt: record.updatedAt,
  }
}

export function environmentDetailLines(view: EnvironmentView): readonly string[] {
  const requested = requestedResourceLine(view)
  const sample = resourceSampleLine(view)
  const gpu = gpuLine(view)
  const account = accountLines(view)
  return [
    `provider: ${view.provider}`,
    `execution: ${view.kind ?? 'unknown'} · ${view.location ?? 'unknown location'}`,
    ...(view.providerEnvironmentId === undefined
      ? []
      : [`provider environment: ${view.providerEnvironmentId}`]),
    `connection: ${view.connectionId}`,
    `lifecycle: ${view.lifecycle} · ${view.lifecycleMode ?? 'unknown'} · cleanup ${view.cleanup ?? 'unknown'}`,
    `continuity: ${view.continuity ?? 'unknown'}`,
    ...(view.storagePersistence === undefined ? [] : [`sandbox home: ${view.storagePersistence}`]),
    ...(view.runtimeEndpointHost === undefined
      ? []
      : [`runtime endpoint host: ${view.runtimeEndpointHost}`]),
    `placement: requested ${view.requestedRegion ?? 'not specified'} · verified ${view.verifiedRegion ?? 'unavailable'}`,
    `machine: ${view.machineId ?? 'unavailable'} · physical IP is not exposed`,
    ...(requested === undefined ? [] : [`requested resources: ${requested}`]),
    ...(sample === undefined ? [] : [`last resource sample: ${sample}`]),
    ...(gpu === undefined ? [] : [`GPU: ${gpu}`]),
    ...account,
    `created: ${view.createdAt}`,
    ...(view.startedAt === undefined ? [] : [`started: ${view.startedAt}`]),
    ...(view.lastActivityAt === undefined ? [] : [`last activity: ${view.lastActivityAt}`]),
    ...(view.expiresAt === undefined ? [] : [`expires: ${view.expiresAt}`]),
    `observed: ${view.updatedAt}`,
    ...view.unavailableTelemetry.map((item) => `unavailable: ${item}`),
  ]
}

function requestedResourceLine(view: EnvironmentView): string | undefined {
  const resources = view.requestedResources
  if (resources === undefined) return undefined
  return [
    ...(resources.cpuCores === undefined ? [] : [`${resources.cpuCores} CPU`]),
    ...(resources.memoryMB === undefined ? [] : [`${resources.memoryMB} MB RAM`]),
    ...(resources.diskGB === undefined ? [] : [`${resources.diskGB} GB disk`]),
    ...(resources.accelerator === undefined
      ? []
      : [`${resources.accelerator.count}× ${resources.accelerator.kind}`]),
  ].join(' · ')
}

function resourceSampleLine(view: EnvironmentView): string | undefined {
  const sample = view.resourceSample
  if (sample === undefined) return undefined
  return [
    `cgroup v${sample.cgroupVersion}`,
    `${sample.memoryCurrentMb.toFixed(1)} MB RAM now`,
    ...(sample.memoryPeakMb === undefined ? [] : [`${sample.memoryPeakMb.toFixed(1)} MB peak`]),
    ...(sample.memoryLimitMb === undefined ? [] : [`${sample.memoryLimitMb.toFixed(1)} MB limit`]),
    `${sample.cpuUsageUsec} µs cumulative CPU`,
    sample.sampledAt,
  ].join(' · ')
}

function gpuLine(view: EnvironmentView): string | undefined {
  const gpu = view.gpu
  if (gpu === undefined) return undefined
  return [
    `${gpu.count}× ${gpu.accelerator}`,
    gpu.provider,
    ...(gpu.instanceType === undefined ? [] : [gpu.instanceType]),
    gpu.status,
    ...(gpu.customerPricePerHourUsd === undefined
      ? []
      : [`$${gpu.customerPricePerHourUsd.toFixed(4)}/hour`]),
    ...(gpu.estimatedCustomerCostUsd === undefined
      ? []
      : [`estimated $${gpu.estimatedCustomerCostUsd.toFixed(4)}`]),
    ...(gpu.billedCustomerCostUsd === undefined
      ? []
      : [`billed $${gpu.billedCustomerCostUsd.toFixed(4)}`]),
    ...(gpu.billedSeconds === undefined ? [] : [`${gpu.billedSeconds}s billed`]),
  ].join(' · ')
}

function accountLines(view: EnvironmentView): readonly string[] {
  const account = view.accountUsage
  if (account === undefined) return []
  const usage = [
    ...(account.computeMinutes === undefined ? [] : [`${account.computeMinutes} compute min`]),
    ...(account.gpuSeconds === undefined ? [] : [`${account.gpuSeconds} GPU sec`]),
    ...(account.gpuCostUsd === undefined ? [] : [`$${account.gpuCostUsd.toFixed(4)} GPU`]),
    ...(account.activeSandboxes === undefined
      ? []
      : [`${account.activeSandboxes} active sandboxes`]),
    ...(account.totalSandboxes === undefined ? [] : [`${account.totalSandboxes} total sandboxes`]),
  ]
  const billing = [
    ...(account.plan === undefined ? [] : [account.plan]),
    ...(account.subscriptionStatus === undefined ? [] : [account.subscriptionStatus]),
    ...(account.creditsAvailableUsd === undefined
      ? []
      : [`$${account.creditsAvailableUsd.toFixed(2)} credits`]),
    ...(account.creditsUsedUsd === undefined
      ? []
      : [`$${account.creditsUsedUsd.toFixed(2)} credits used`]),
    ...(account.monthlyBalanceUsd === undefined
      ? []
      : [`$${account.monthlyBalanceUsd.toFixed(2)} monthly balance`]),
  ]
  const limits = [
    ...(account.maximumConcurrentSandboxes === undefined
      ? []
      : [`${account.maximumConcurrentSandboxes} concurrent`]),
    ...(account.maximumCpuCores === undefined ? [] : [`${account.maximumCpuCores} CPU`]),
    ...(account.maximumRamGB === undefined ? [] : [`${account.maximumRamGB} GB RAM`]),
    ...(account.maximumStorageGB === undefined ? [] : [`${account.maximumStorageGB} GB storage`]),
  ]
  return [
    ...(account.customerId === undefined ? [] : [`sandbox customer: ${account.customerId}`]),
    ...(account.billingOwnerId === undefined
      ? []
      : [`sandbox billing owner: ${account.billingOwnerId}`]),
    ...(usage.length === 0 ? [] : [`sandbox account usage: ${usage.join(' · ')}`]),
    ...(billing.length === 0 ? [] : [`sandbox subscription: ${billing.join(' · ')}`]),
    ...(limits.length === 0 ? [] : [`sandbox limits: ${limits.join(' · ')}`]),
    ...(account.usagePeriodStart === undefined || account.usagePeriodEnd === undefined
      ? []
      : [`usage period: ${account.usagePeriodStart} → ${account.usagePeriodEnd}`]),
    ...(account.subscriptionPeriodEnd === undefined
      ? []
      : [`subscription period ends: ${account.subscriptionPeriodEnd}`]),
    `sandbox account measurement: ${account.completeness} · not per-run billing`,
  ]
}

function safe(value: string): string {
  return sanitizeTerminalText(value)
}
