export const DEFAULT_TANGLE_ROUTER_MODEL_ID = 'glm-5.3'
export const DEFAULT_TANGLE_ROUTER_MODEL = `tangle-router/${DEFAULT_TANGLE_ROUTER_MODEL_ID}`

/**
 * Release proofs bill the braid-release-proof Router keys, and internal model calls spend no
 * per-token cash (all-costs #10337). Router calls are pinned to the flat Z.ai plan with no
 * substitute provider or model, so a Z.ai limit fails the proof instead of paying a metered host.
 * A Tangle inference connection sends the pin on every Router request; a Tangle Sandbox fixes it
 * at create, where only Router-backed OpenCode accepts it, so other sandbox runners get none.
 */
export function releaseProofRouting(runner, kind = 'tangle-sandbox') {
  return kind === 'tangle-inference' || runner === 'opencode'
    ? { routing: { only: ['zai'], allowFallbacks: false, requireModel: true } }
    : {}
}
