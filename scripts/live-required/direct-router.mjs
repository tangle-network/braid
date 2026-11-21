import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertDirectProofRoute } from './direct-router-contract.mjs'
import { runtimeModuleRoot } from './tangle-workspace-proof.mjs'

/** Read the same Router and origin-bound credential the candidate will use for the turn. */
export async function directRouterEvidence(repository, environment, config) {
  const model = config.profile.model.default
  const { only, allowFallbacks, requireModel } = config.connection.providerOptions.routing
  if (only?.length !== 1) throw new Error('Direct Router proof must select exactly one provider')
  const route = {
    model,
    provider: only[0],
    allowFallbacks,
    requireModel,
    streamRequested: config.profile.model.metadata?.stream === true,
  }
  if (route.provider === 'openrouter') {
    const dist = runtimeModuleRoot(repository, environment)
    const load = (file) => import(pathToFileURL(join(dist, file)).href)
    const [credentials, contextModule, mapping, endpoints, router] = await Promise.all([
      load('adapters/connections/production-connection-credentials.js'),
      load('bin/production-credential-context.js'),
      load('bin/production-credential-reference.js'),
      load('adapters/connections/production-connection-endpoints.js'),
      load('adapters/connections/tangle-router-client.js'),
    ])
    const context = contextModule.createProductionCredentialContext(config)
    if (!context) throw new Error('Direct Router catalog requires the proof connection credential')
    try {
      const endpoint = endpoints.normalizeTangleInferenceRuntimeBaseUrl(config.connection.endpoint)
      const key = await credentials.readConnectionCredential(
        config.connection,
        {
          credentials: context.store,
          credentialRefResolver: mapping.defaultProductionCredentialRefResolver,
        },
        endpoint,
      )
      const response = await fetch(`${endpoint}/models`, {
        headers: { ...router.tangleRouterClientHeaders(), authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`Direct Router catalog returned HTTP ${response.status}`)
      const { data } = await response.json()
      const matches = Array.isArray(data) ? data.filter((row) => row?.id === model) : []
      if (matches.length !== 1)
        throw new Error('Direct Router catalog must identify exactly one matching free model')
      const [row] = matches
      const path = row.routeability
      route.catalog = {
        id: row.id,
        provider: path?.provider,
        mode: path?.mode,
        via: path?.via,
        chatRouteable:
          path?.routeable === true && path.endpoints?.chat_completions?.routeable === true,
        pricingSource: row.pricing_source,
        pricing: row.pricing,
      }
    } finally {
      context.dispose()
    }
  }
  assertDirectProofRoute(model, route)
  return route
}
