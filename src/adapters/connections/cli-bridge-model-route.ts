import type { HarnessType } from '@tangle-network/agent-interface'
import { harnessSupportsModel, harnessTypeSchema } from '../agent-interface/harness-runtime.js'

/** Returns the runner encoded by a CLI Bridge `<runner>/<model>` route. */
export function bridgeRouteRunner(model: string): HarnessType | undefined {
  const separator = model.indexOf('/')
  if (separator <= 0) return undefined
  const parsed = harnessTypeSchema.safeParse(model.slice(0, separator))
  return parsed.success ? parsed.data : undefined
}

/** Validates a portable model id against a runner. */
export function bridgeRunnerSupportsModel(runner: HarnessType, model: string): boolean {
  return harnessSupportsModel(runner, portableBridgeModel(runner, model))
}

/** Combine split AgentProfile provider/model hints without adding a Bridge runner prefix. */
export function qualifyBridgeProfileModel(model: string, provider?: string): string {
  const selectedProvider = provider?.trim()
  if (selectedProvider === undefined || selectedProvider.length === 0) return model
  return model === selectedProvider || model.startsWith(`${selectedProvider}/`)
    ? model
    : `${selectedProvider}/${model}`
}

/** Accept a pre-portability Bridge route without preserving its transport-only runner prefix. */
export function portableBridgeModel(runner: HarnessType, model: string, provider?: string): string {
  const portable = bridgeRouteRunner(model) === runner ? model.slice(runner.length + 1) : model
  return qualifyBridgeProfileModel(portable, provider)
}

/** Materialize the Bridge `<runner>/<model>` or `<runner>/<provider>/<model>` route. */
export function materializeBridgeModelRoute(
  runner: HarnessType,
  model: string,
  provider?: string,
): string {
  const portable = portableBridgeModel(runner, model, provider)
  return bridgeRouteRunner(portable) === runner ? portable : `${runner}/${portable}`
}

export interface BridgeCatalogTarget {
  readonly route: string
  readonly runner: HarnessType
  readonly provider?: string
  readonly model: string
}

/** Split a Bridge catalog route into transport identity and portable profile fields. */
export function bridgeCatalogTarget(
  route: string,
  backend: string | undefined,
): BridgeCatalogTarget | undefined {
  const runner = bridgeCatalogRunner(route, backend)
  if (runner === undefined) return undefined
  const model = route.slice(runner.length + 1)
  if (model.length === 0) return undefined
  const providerSeparator = model.indexOf('/')
  return {
    route,
    runner,
    model,
    ...(providerSeparator > 0 ? { provider: model.slice(0, providerSeparator) } : {}),
  }
}

/** Accepts a catalog entry only when its backend agrees with its encoded route. */
export function bridgeCatalogRunner(
  model: string,
  backend: string | undefined,
): HarnessType | undefined {
  const routedRunner = bridgeRouteRunner(model)
  if (backend === undefined) return routedRunner
  const parsed = harnessTypeSchema.safeParse(backend)
  if (!parsed.success || routedRunner !== parsed.data) return undefined
  return parsed.data
}
