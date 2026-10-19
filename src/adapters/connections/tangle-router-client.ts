import type { ExecutorFactory } from '@tangle-network/agent-runtime/kernel'
import type { ConnectionRecord, ConnectionRouterRouting } from '../../domain/entities.js'
import { BRAID_VERSION } from '../../version.js'

/**
 * The Tangle router records this header as the request's client name, which is how
 * tangle-admin attributes usage to Braid rather than to an anonymous API key.
 */
export const TANGLE_CLIENT_HEADER = 'x-tangle-client'
export const BRAID_TANGLE_CLIENT = `braid/${BRAID_VERSION}`

/** Headers every request Braid itself sends to the Tangle router carries. */
export function tangleRouterClientHeaders(): Readonly<Record<string, string>> {
  return { [TANGLE_CLIENT_HEADER]: BRAID_TANGLE_CLIENT }
}

/**
 * Identify Braid on every request a Runtime Router executor sends.
 *
 * Runtime's Router executor merges `ExecutorContext.propagatedHeaders` into each outbound
 * request, ahead of its own content-type, authorization, idempotency, and correlation headers.
 * Setting the client header there keeps Runtime's own transport, retries, streaming, and usage
 * parsing unchanged. Braid's identity replaces any inherited client header, compared without
 * case, so the router never receives two values.
 */
export function withTangleRouterClient<Out>(factory: ExecutorFactory<Out>): ExecutorFactory<Out> {
  return (spec, context) => {
    const inherited = Object.entries(context.propagatedHeaders ?? {}).filter(
      ([name]) => name.toLowerCase() !== TANGLE_CLIENT_HEADER,
    )
    return factory(spec, {
      ...context,
      propagatedHeaders: Object.freeze({
        ...Object.fromEntries(inherited),
        ...tangleRouterClientHeaders(),
      }),
    })
  }
}

/** The connection's Router provider routing, shaped for Runtime's Router executor config. */
export function connectionRouterRouting(record: Pick<ConnectionRecord, 'providerOptions'>): {
  readonly routing?: ConnectionRouterRouting
} {
  const routing = record.providerOptions.routing
  return routing === undefined ? {} : { routing: structuredClone(routing) }
}

/** The same routing in the Router's request-body form, for requests Braid sends itself. */
export function routerRoutingBody(
  record: Pick<ConnectionRecord, 'providerOptions'>,
): Readonly<Record<string, unknown>> {
  const routing = record.providerOptions.routing
  if (routing === undefined) return {}
  const gateway = {
    ...(routing.only === undefined ? {} : { only: [...routing.only] }),
    ...(routing.allowFallbacks === undefined ? {} : { allowFallbacks: routing.allowFallbacks }),
  }
  return {
    ...(Object.keys(gateway).length === 0 ? {} : { providerOptions: { gateway } }),
    ...(routing.requireModel === undefined ? {} : { require_model: routing.requireModel }),
  }
}
