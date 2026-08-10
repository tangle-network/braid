import type { SandboxIdentity, SubscriptionInfo, UsageInfo } from '@tangle-network/sandbox'
import type { SandboxAccountObservation } from '../../domain/execution-observation.js'
import type {
  MutableSandboxObservation,
  ObservableSandboxClient,
} from './sandbox-observation-types.js'

export function observeSandboxAccount(
  client: ObservableSandboxClient,
  state: MutableSandboxObservation,
  unavailable: Set<string>,
  track: (task: Promise<void>) => void,
  now: () => string,
): void {
  let identity: SandboxIdentity | undefined
  let usage: UsageInfo | undefined
  let subscription: SubscriptionInfo | undefined

  const publish = (): void => {
    state.account = accountObservation(identity, usage, subscription, now())
  }
  if (client.getIdentity === undefined)
    unavailable.add('sandbox-account-identity:not-exposed-by-client')
  else
    track(
      Promise.resolve()
        .then(() => client.getIdentity?.())
        .then((value) => {
          identity = value
          publish()
        })
        .catch(() => {
          unavailable.add('sandbox-account-identity:request-failed')
        }),
    )
  if (client.usage === undefined) unavailable.add('sandbox-account-usage:not-exposed-by-client')
  else
    track(
      Promise.resolve()
        .then(() => client.usage?.())
        .then((value) => {
          usage = value
          publish()
        })
        .catch(() => {
          unavailable.add('sandbox-account-usage:request-failed')
        }),
    )
  if (client.subscription === undefined)
    unavailable.add('sandbox-subscription:not-exposed-by-client')
  else
    track(
      Promise.resolve()
        .then(() => client.subscription?.())
        .then((value) => {
          subscription = value
          publish()
        })
        .catch(() => {
          unavailable.add('sandbox-subscription:request-failed')
        }),
    )
}

function accountObservation(
  identity: SandboxIdentity | undefined,
  usage: UsageInfo | undefined,
  subscription: SubscriptionInfo | undefined,
  sampledAt: string,
): SandboxAccountObservation | undefined {
  if (identity === undefined && usage === undefined && subscription === undefined) return undefined
  return {
    scope: 'account',
    completeness: 'provider-reported-possibly-defaulted',
    ...(identity === undefined
      ? {}
      : { customerId: identity.customerId, billingOwnerId: identity.billingOwnerId }),
    ...(usage === undefined
      ? {}
      : {
          computeMinutes: usage.computeMinutes,
          gpuSeconds: usage.gpuSeconds,
          gpuCostUsd: usage.gpuCostUsd,
          activeSandboxes: usage.activeSandboxes,
          totalSandboxes: usage.totalSandboxes,
          usagePeriodStart: usage.periodStart.toISOString(),
          usagePeriodEnd: usage.periodEnd.toISOString(),
        }),
    ...(subscription === undefined
      ? {}
      : {
          creditsAvailableUsd: subscription.creditsAvailableUsd,
          creditsUsedUsd: subscription.creditsUsedUsd,
          monthlyBalanceUsd: subscription.monthlyBalanceUsd,
          plan: subscription.plan,
          subscriptionStatus: subscription.status,
          maximumConcurrentSandboxes: subscription.maxConcurrentSandboxes,
          maximumCpuCores: subscription.limits.maxCpuCores,
          maximumRamGB: subscription.limits.maxRamGB,
          maximumStorageGB: subscription.limits.maxStorageGB,
          subscriptionPeriodEnd: new Date(subscription.currentPeriodEnd).toISOString(),
        }),
    sampledAt,
  }
}
