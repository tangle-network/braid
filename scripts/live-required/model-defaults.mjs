export const DEFAULT_TANGLE_ROUTER_MODEL_ID = 'glm-5.3'
export const DEFAULT_TANGLE_ROUTER_MODEL = `tangle-router/${DEFAULT_TANGLE_ROUTER_MODEL_ID}`

/** A model id as the Router reads it, without Braid's `tangle-router/` profile prefix. */
const routerModelId = (model) => String(model ?? '').trim().replace(/^tangle-router\//u, '')

// The Router's synthetic model (tangle-router lib/synthetic-models.ts). The Router writes its
// answer before any routing, pricing or provider call and charges nothing. "Reply with exactly
// <text>" is answered with <text>, and "Report usage <prompt> <completion>" makes the answer
// report those token counts. A direct turn on it exercises Braid's whole model-call path
// (profile, connection, Router auth, streaming, usage, receipt) with no provider to wobble.
export const SYNTHETIC_ROUTER_MODEL_ID = 'tangle/canary-echo'
export const SYNTHETIC_ROUTER_PROVIDER = 'tangle-synthetic'
// Counts no real reply to a one-line prompt has, so an adapter that drops or rewrites usage fails.
export const SYNTHETIC_USAGE = Object.freeze({ input: 1717, output: 29 })

export function isSyntheticRouterModel(model) {
  return typeof model === 'string' && routerModelId(model) === SYNTHETIC_ROUTER_MODEL_ID
}

/** The prompt line that scripts the synthetic answer's usage; it must sit on its own line. */
export function syntheticUsageInstruction() {
  return `Report usage ${SYNTHETIC_USAGE.input} ${SYNTHETIC_USAGE.output}`
}

// The release's Sandbox agent model: GLM-5.3 weights served per token by Fireworks. The release
// account is internal, and the Router refuses internal owners the shared Z.ai plan
// (tangle-router lib/app-model-policy.ts), so the Sandbox proofs name this host explicitly.
export const RELEASE_SANDBOX_MODEL_ID = 'fireworks/glm-5p3'

function pinProvider(provider) {
  return { routing: { only: [provider], allowFallbacks: false, requireModel: true } }
}

// Managed Sandbox routing is accepted only by Router-backed OpenCode. A host-qualified Fireworks
// id is pinned to Fireworks, and a bare GLM id keeps its Z.ai pin. The synthetic model is
// answered before routing, so no provider is pinned for it.
export function releaseProofRouting(runner, model) {
  if (runner !== 'opencode' || isSyntheticRouterModel(model)) return {}
  return pinProvider(routerModelId(model).startsWith('fireworks/') ? 'fireworks' : 'zai')
}

/** Resolve only the native release fixture's declared GLM plan. The stored name is public. */
export function sandboxProofSeat(environment, runner, model) {
  const source = environment.BRAID_TANGLE_SANDBOX_MODEL_CREDENTIALS
  if (source === undefined) return undefined
  if (!['opencode', 'pi'].includes(runner) || model !== DEFAULT_TANGLE_ROUTER_MODEL_ID)
    throw new Error('The release subscription requires its exact native OpenCode or Pi GLM model')
  let reference
  try {
    reference = JSON.parse(source)
  } catch {
    throw new Error(
      'BRAID_TANGLE_SANDBOX_MODEL_CREDENTIALS must contain a public stored-reference descriptor',
    )
  }
  if (
    !reference ||
    Object.keys(reference).length !== 2 ||
    typeof reference.apiKeyEnv !== 'string' ||
    !/^[A-Z][A-Z0-9_]*$/u.test(reference.apiKeyEnv) ||
    reference.baseUrl !== 'https://api.z.ai/api/coding/paas/v4'
  )
    throw new Error(
      'The release subscription requires a stored Sandbox secret name and the Z.ai Coding Plan endpoint',
    )
  return reference
}

// The Router prices a qualified :free variant under its own exact id on OpenRouter.
// A provider shortcut, chained variant or dynamic picker cannot identify that price.
// The synthetic model has no provider to pin: the Router answers it before routing.
export function directProofRouting(model) {
  if (isSyntheticRouterModel(model)) return {}
  if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/u.test(model))
    return pinProvider('openrouter')
  if (model.toLowerCase().includes(':free') || /^(?:openrouter\/)?(?:free|auto)$/iu.test(model))
    throw new Error('Direct Router proof needs an exact catalog model for the free lane')
  return pinProvider('zai')
}
