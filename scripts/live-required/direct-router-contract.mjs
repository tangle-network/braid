import { directProofRouting } from './model-defaults.mjs'

const TOKEN_PRICES = ['prompt', 'completion', 'input_cache_read', 'input_cache_write']

// Number("1e-999") rounds to zero. Preserve the exact decimal the Router published.
function explicitZero(rate) {
  return rate === 0 || (typeof rate === 'string' && /^0+(?:\.0+)?(?:[eE][+-]?\d+)?$/u.test(rate))
}

export function assertDirectProofRoute(model, route) {
  const { routing } = directProofRouting(model)
  if (
    route?.model !== model ||
    route.provider !== routing.only[0] ||
    route.allowFallbacks !== false ||
    route.requireModel !== true ||
    route.streamRequested !== true
  )
    throw new Error('Direct Router proof must stream from its exact model and provider')
  if (route.provider !== 'openrouter') return
  const card = route.catalog
  if (
    card?.id !== model ||
    card.provider !== route.provider ||
    card.mode !== 'system' ||
    card.via !== route.provider ||
    card.chatRouteable !== true ||
    card.pricingSource !== 'provider_price_version' ||
    !card.pricing ||
    TOKEN_PRICES.some((name) => !Object.hasOwn(card.pricing, name)) ||
    !Object.values(card.pricing).every(explicitZero)
  )
    throw new Error(
      'Direct Router proof requires a routeable system provider and its published zero rates',
    )
}

export function validatePassedTangleInferenceReceipt(receipt) {
  const { facts, run } = receipt
  const model = receipt.connection.model
  const router = receipt.observations?.router
  if (
    router !== undefined ||
    (typeof model === 'string' && directProofRouting(model).routing.only[0] === 'openrouter')
  ) {
    assertDirectProofRoute(model, router)
    const completion = receipt.observations.completion
    if (
      completion?.runId !== facts.normalRunId ||
      completion.model !== model ||
      !Number.isSafeInteger(completion.input) ||
      completion.input <= 0 ||
      !Number.isSafeInteger(completion.output) ||
      completion.output <= 0
    )
      throw new Error('Direct Router completion needs the exact recorded model and measured usage')
    if (
      router.provider === 'openrouter' &&
      completion.billedUsd !== null &&
      completion.billedUsd !== 0
    )
      throw new Error('Free Router completion must have no reported charge')
  }
  const checks = new Set(receipt.checks)
  if (facts.cancellationStatus === 'confirmed') {
    if (!checks.has('cancelled-turn') || checks.has('cancellation-reported-unavailable'))
      throw new Error('Confirmed Tangle inference proof requires the cancelled-turn check')
    if (facts.cancellationResponseCode !== null)
      throw new Error('Confirmed Tangle inference cancellation must have no response code')
    if (facts.cancelledRunId === facts.normalRunId)
      throw new Error('Confirmed Tangle inference cancellation must use a distinct run ID')
    if (run.ids.length !== 2)
      throw new Error('Confirmed Tangle inference proof requires normal and cancelled run IDs')
    if (!run.ids.includes(facts.normalRunId) || !run.ids.includes(facts.cancelledRunId))
      throw new Error('Confirmed Tangle inference proof is missing a referenced run ID')
    return
  }
  if (facts.cancellationStatus !== 'reported-unavailable')
    throw new Error(
      'Passed Tangle inference proof requires confirmed or reported-unavailable cancellation',
    )
  if (!checks.has('cancellation-reported-unavailable') || checks.has('cancelled-turn'))
    throw new Error(
      'Unavailable Tangle inference proof requires the cancellation-reported-unavailable check',
    )
  if (facts.cancelledRunId !== null)
    throw new Error('Unavailable Tangle inference cancellation cannot have a cancelled run ID')
  if (!['CAPABILITY_UNAVAILABLE', 'UNKNOWN_RUN'].includes(facts.cancellationResponseCode))
    throw new Error('Unavailable Tangle inference cancellation requires a recognized response code')
  if (run.ids.length !== 1 || run.ids[0] !== facts.normalRunId)
    throw new Error('Unavailable Tangle inference proof requires only the normal run ID')
}
