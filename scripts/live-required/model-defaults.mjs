export const DEFAULT_TANGLE_ROUTER_MODEL_ID = 'glm-5.3'
export const DEFAULT_TANGLE_ROUTER_MODEL = `tangle-router/${DEFAULT_TANGLE_ROUTER_MODEL_ID}`

function pinProvider(provider) {
  return { routing: { only: [provider], allowFallbacks: false, requireModel: true } }
}

// Managed Sandbox routing is accepted only by Router-backed OpenCode.
export function releaseProofRouting(runner) {
  return runner === 'opencode' ? pinProvider('zai') : {}
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
export function directProofRouting(model) {
  if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/u.test(model))
    return pinProvider('openrouter')
  if (model.toLowerCase().includes(':free') || /^(?:openrouter\/)?(?:free|auto)$/iu.test(model))
    throw new Error('Direct Router proof needs an exact catalog model for the free lane')
  return pinProvider('zai')
}
