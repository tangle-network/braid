import { protectedUnavailable } from './contracts.mjs'

function textValue(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function firstValue(environment, names) {
  return names
    .map((name) => environment[name])
    .map(textValue)
    .find((value) => value !== undefined)
}

/**
 * Resolve the model provider without changing the portable model id.
 *
 * The caller supplies the owning path's fallback because a model prefix can
 * identify an upstream model, not the connection's provider.
 */
export function resolveModelProvider({ override, fallback } = {}) {
  return textValue(override) ?? textValue(fallback)
}

function credential(environment, prefix, fallbacks = []) {
  const reference = firstValue(environment, [`${prefix}_CREDENTIAL_REF`, ...fallbacks])
  const value = firstValue(environment, [`${prefix}_AUTH`, `${prefix}_API_KEY`, `${prefix}_BEARER`])
  if (!reference && !value) {
    throw protectedUnavailable(
      'PROTECTED_CREDENTIAL_REQUIRED',
      `${prefix} requires a protected credential reference or an authentication value that Braid can install in its protected credential store`,
    )
  }
  return {
    ...(reference ? { credentialRef: reference } : {}),
    ...(value ? { credentialValue: value } : {}),
  }
}

export function connectionConfiguration(
  environment,
  {
    prefix,
    kind,
    endpointNames = [],
    modelNames = [],
    runnerNames = [],
    providerNames = [],
    modelProviderNames = [],
    fallbackEndpoint,
    fallbackModel,
    fallbackRunner,
    fallbackModelProvider,
    credentialFallbacks = [],
  },
) {
  const endpoint =
    firstValue(environment, [`${prefix}_ENDPOINT`, ...endpointNames]) ?? fallbackEndpoint
  const model = firstValue(environment, [`${prefix}_MODEL`, ...modelNames]) ?? fallbackModel
  const runner = firstValue(environment, [`${prefix}_RUNNER`, ...runnerNames]) ?? fallbackRunner
  const modelProvider = resolveModelProvider({
    override: firstValue(environment, [
      `${prefix}_MODEL_PROVIDER`,
      ...modelProviderNames,
      `${prefix}_PROVIDER`,
      ...providerNames,
    ]),
    fallback: fallbackModelProvider,
  })
  const missing = [
    [endpoint, `${prefix}_ENDPOINT`, 'provider endpoint'],
    [model, `${prefix}_MODEL`, 'profile model'],
    [runner, `${prefix}_RUNNER`, 'profile harness'],
  ]
    .filter(([value]) => typeof value !== 'string' || value.trim().length === 0)
    .map(([, name, description]) => `${name} (${description})`)
  if (missing.length > 0) {
    throw protectedUnavailable(
      'PROTECTED_CONFIGURATION_REQUIRED',
      `${kind} live check requires ${missing.join(', ')}`,
    )
  }
  return {
    kind,
    endpoint,
    model,
    runner,
    ...(modelProvider === undefined ? {} : { modelProvider }),
    ...credential(environment, prefix, credentialFallbacks),
  }
}
