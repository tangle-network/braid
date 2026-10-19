export const DEFAULT_TANGLE_ROUTER_MODEL_ID = 'glm-5.3'
export const DEFAULT_TANGLE_ROUTER_MODEL = `tangle-router/${DEFAULT_TANGLE_ROUTER_MODEL_ID}`

/**
 * Release proofs bill the braid-release-proof Router keys, and internal model calls spend no
 * per-token cash (all-costs #10337). Router-backed OpenCode is pinned to the flat Z.ai plan with no
 * substitute provider or model, so a Z.ai limit fails the proof instead of paying a metered host.
 * Other runners refuse routing at create, so they get none.
 */
export function releaseProofRouting(runner) {
  return runner === 'opencode'
    ? { routing: { only: ['zai'], allowFallbacks: false, requireModel: true } }
    : {}
}
