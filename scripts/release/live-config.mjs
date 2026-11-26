import {
  RELEASE_SANDBOX_MODEL_ID,
  SYNTHETIC_ROUTER_MODEL_ID,
} from '../live-required/model-defaults.mjs'

// The protected release's public configuration. It is committed so a release proves the route
// its source names. The `release-live` secret and the operator's key files hold only the two keys.
//
// LIVE-06 runs the Router's synthetic model: a deterministic, free answer that exercises Braid's
// whole model-call path. The Sandbox proofs need an agent that runs tools across turns, so they
// run a served model (model-defaults.mjs says why it is the Fireworks host).
export const RELEASE_LIVE_CONFIG = Object.freeze({
  BRAID_TANGLE_ENDPOINT: 'https://router.tangle.tools/v1',
  BRAID_TANGLE_MODEL: SYNTHETIC_ROUTER_MODEL_ID,
  BRAID_TANGLE_SANDBOX_ENDPOINT: 'https://sandbox.tangle.tools',
  BRAID_TANGLE_SANDBOX_MODEL: `tangle-router/${RELEASE_SANDBOX_MODEL_ID}`,
  BRAID_TANGLE_SANDBOX_RUNNER: 'opencode',
})

// The Router key runs LIVE-06. The Sandbox key creates the release Sandboxes, whose own Router
// keys Platform mints from it.
export const RELEASE_CREDENTIALS = Object.freeze({
  router: 'BRAID_TANGLE_API_KEY',
  sandbox: 'TANGLE_API_KEY',
})

/** The protected secret's two keys, refused when it holds anything else. */
export function releaseCredentials(source) {
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error('The release credentials are not valid JSON', { cause: error })
  }
  const expected = Object.values(RELEASE_CREDENTIALS).sort()
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expected)
  )
    throw new Error(
      `The release credentials must hold exactly ${expected.join(' and ')}; public configuration lives in scripts/release/live-config.mjs`,
    )
  for (const name of expected)
    if (typeof parsed[name] !== 'string' || parsed[name].trim() !== parsed[name] || !parsed[name])
      throw new Error(`The release credential ${name} must be a nonempty key without whitespace`)
  return parsed
}

/** The release secret's JSON built from the two key values. */
export function releaseCredentialsJson({ router, sandbox }) {
  return JSON.stringify(
    releaseCredentials(
      JSON.stringify({
        [RELEASE_CREDENTIALS.router]: router,
        [RELEASE_CREDENTIALS.sandbox]: sandbox,
      }),
    ),
  )
}
