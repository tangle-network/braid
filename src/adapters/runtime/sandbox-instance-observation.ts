import type { SandboxInstanceLike } from '@tangle-network/agent-provider-tangle'
import type { GpuLease } from '@tangle-network/sandbox'
import type {
  EnvironmentGpuObservation,
  EnvironmentResourceRequest,
  ObservedEnvironmentLifecycle,
} from '../../domain/execution-observation.js'
import { endpointLocation } from './execution-observation-source.js'
import {
  boundedObservationText,
  type MutableSandboxObservation,
  type ObservableSandboxInstance,
  observationDate,
  observationRecord,
  positiveObservationNumber,
  settleWithin,
} from './sandbox-observation-types.js'

export function wrapObservedSandboxBox(
  box: ObservableSandboxInstance,
  state: MutableSandboxObservation,
  unavailable: Set<string>,
): SandboxInstanceLike {
  const remove = box.delete?.bind(box)
  return new Proxy(box, {
    get(target, property) {
      if (property === 'delete' && remove !== undefined) {
        return async (options?: { readonly signal?: AbortSignal }): Promise<void> => {
          state.lifecycle = 'destroying'
          await captureResourceSample(state, target, unavailable).catch(() => {
            unavailable.add('runtime-cpu-memory-usage:request-failed-or-timed-out')
          })
          let failure: unknown
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await remove(options)
              state.lifecycle = 'destroyed'
              return
            } catch (error) {
              failure = error
            }
          }
          state.lifecycle = 'unknown'
          unavailable.add('cleanup-outcome:unknown')
          throw failure
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export function captureSandboxBox(
  state: MutableSandboxObservation,
  box: ObservableSandboxInstance,
  unavailable: Set<string>,
): void {
  state.providerEnvironmentId = boundedObservationText(box.id)
  state.name = boundedObservationText(box.name) ?? state.name
  state.lifecycle = observedLifecycle(box.status)
  state.createdAt = observationDate(box.createdAt) ?? state.createdAt
  state.startedAt = observationDate(box.startedAt)
  state.lastActivityAt = observationDate(box.lastActivityAt)
  state.expiresAt = observationDate(box.expiresAt)
  const runtimeUrl = boundedObservationText(box.connection?.runtimeUrl)
  if (runtimeUrl !== undefined)
    state.runtimeEndpointHost = endpointLocation(runtimeUrl).runtimeEndpointHost
  state.gpu = gpuObservation(box.gpuLease)
  if (state.lifecycle === 'unknown')
    unavailable.add('sandbox-lifecycle:not-reported-or-unrecognized')
}

export function captureSandboxPlacement(
  state: MutableSandboxObservation,
  value: unknown,
  unavailable: Set<string>,
): void {
  const record = observationRecord(value)
  if (record === undefined) {
    unavailable.add('verified-placement:empty-response')
    return
  }
  state.machineId = boundedObservationText(record.machineId)
  state.region = boundedObservationText(record.region)
}

export function requestedSandboxResources(value: unknown): EnvironmentResourceRequest | undefined {
  const record = observationRecord(value)
  if (record === undefined) return undefined
  const cpuCores = positiveObservationNumber(record.cpuCores ?? record.cpu)
  const memoryMB = positiveObservationNumber(record.memoryMB ?? record.memoryMb)
  const diskMb = positiveObservationNumber(record.diskMb)
  const diskGB =
    positiveObservationNumber(record.diskGB) ?? (diskMb === undefined ? undefined : diskMb / 1_024)
  const acceleratorRecord = observationRecord(record.accelerator)
  const acceleratorKind = boundedObservationText(acceleratorRecord?.kind ?? record.gpu)
  const acceleratorCount = positiveObservationNumber(acceleratorRecord?.count) ?? 1
  const acceleratorMemory = positiveObservationNumber(acceleratorRecord?.memoryMB)
  if (
    cpuCores === undefined &&
    memoryMB === undefined &&
    diskGB === undefined &&
    acceleratorKind === undefined
  )
    return undefined
  return {
    ...(cpuCores === undefined ? {} : { cpuCores }),
    ...(memoryMB === undefined ? {} : { memoryMB }),
    ...(diskGB === undefined ? {} : { diskGB }),
    ...(acceleratorKind === undefined
      ? {}
      : {
          accelerator: {
            kind: acceleratorKind,
            count: acceleratorCount,
            ...(acceleratorMemory === undefined ? {} : { memoryMB: acceleratorMemory }),
          },
        }),
  }
}

export function requestedSandboxRegion(value: unknown): string | undefined {
  return boundedObservationText(observationRecord(value)?.preferredRegion)
}

async function captureResourceSample(
  state: MutableSandboxObservation,
  box: ObservableSandboxInstance,
  unavailable: Set<string>,
): Promise<void> {
  if (box.resourceUsage === undefined) {
    unavailable.add('runtime-cpu-memory-usage:not-exposed-by-client')
    return
  }
  const result = await settleWithin(
    Promise.resolve().then(() => box.resourceUsage?.()),
    750,
  )
  if (result === undefined) {
    unavailable.add('runtime-cpu-memory-usage:request-failed-or-timed-out')
    return
  }
  if (result === null) {
    unavailable.add('runtime-cpu-memory-usage:unavailable-on-host')
    return
  }
  state.resourceSample = {
    cgroupVersion: result.cgroupVersion,
    memoryCurrentMb: result.memoryCurrentMb,
    ...(result.memoryPeakMb === null ? {} : { memoryPeakMb: result.memoryPeakMb }),
    ...(result.memoryLimitMb === null ? {} : { memoryLimitMb: result.memoryLimitMb }),
    cpuUsageUsec: result.cpuUsageUsec,
    sampledAt: new Date(result.sampledAtMs).toISOString(),
  }
}

function gpuObservation(lease: GpuLease | undefined): EnvironmentGpuObservation | undefined {
  if (lease === undefined) return undefined
  const instanceType = boundedObservationText(lease.providerInstanceType)
  const region = boundedObservationText(lease.region)
  return {
    provider: lease.provider,
    ...(instanceType === undefined ? {} : { instanceType }),
    ...(region === undefined ? {} : { region }),
    accelerator: lease.accelerator.kind,
    count: lease.accelerator.count,
    status: lease.status,
    ...(lease.customerPricePerHourUsd === undefined
      ? {}
      : { customerPricePerHourUsd: lease.customerPricePerHourUsd }),
    ...(lease.estimatedCustomerCostUsd === undefined
      ? {}
      : { estimatedCustomerCostUsd: lease.estimatedCustomerCostUsd }),
    ...(lease.billing === undefined
      ? {}
      : {
          billedSeconds: lease.billing.seconds,
          billedCustomerCostUsd: lease.billing.customerCostUsd,
        }),
  }
}

function observedLifecycle(value: unknown): ObservedEnvironmentLifecycle {
  switch (value) {
    case 'pending':
      return 'requested'
    case 'provisioning':
      return 'creating'
    case 'running':
      return 'ready'
    case 'stopped':
      return 'detached'
    case 'failed':
      return 'failed'
    case 'expired':
      return 'expired'
    case 'deleted':
      return 'destroyed'
    default:
      return 'unknown'
  }
}
