import {
  type HarnessType,
  harnessSupportsModel,
  harnessTypeSchema,
} from '@tangle-network/agent-interface'

/** Returns the runner encoded by a CLI Bridge `<runner>/<model>` route. */
export function bridgeRouteRunner(model: string): HarnessType | undefined {
  const separator = model.indexOf('/')
  if (separator <= 0) return undefined
  const parsed = harnessTypeSchema.safeParse(model.slice(0, separator))
  return parsed.success ? parsed.data : undefined
}

/** Validates a model against either an explicit Bridge route or a canonical model id. */
export function bridgeRunnerSupportsModel(runner: HarnessType, model: string): boolean {
  const routedRunner = bridgeRouteRunner(model)
  return routedRunner === undefined ? harnessSupportsModel(runner, model) : routedRunner === runner
}

/** Materialize the same `<runner>/<provider>/<model>` route used by the CLI Bridge provider. */
export function materializeBridgeModelRoute(
  runner: HarnessType,
  model: string,
  provider?: string,
): string {
  if (model === runner || model.startsWith(`${runner}/`)) return model
  if (model.includes('/')) return `${runner}/${model}`
  return provider === undefined ? `${runner}/${model}` : `${runner}/${provider}/${model}`
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
