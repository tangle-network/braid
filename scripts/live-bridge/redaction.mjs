import { collectCredentialSecrets } from '../release/redaction.mjs'

const secretKeys = new Set([
  'authorization',
  'bearer',
  'token',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'secret',
  'secretvalue',
  'password',
  'cookie',
  'credential',
  'credentialvalue',
])

const bridgeSecretEnvironmentKeys = Object.freeze([
  'BRAID_CLI_BRIDGE_BEARER',
  'CLI_BRIDGE_BEARER',
  'BRIDGE_BEARER',
])

const braidLiveSecretEnvironmentKeys = Object.freeze([
  'BRAID_ANALYSIS_AUTH',
  'BRAID_ANALYSIS_API_KEY',
  'BRAID_ANALYSIS_BEARER',
  'BRAID_CLI_BRIDGE_AUTH',
  'BRAID_CLI_BRIDGE_API_KEY',
  'BRAID_CLI_BRIDGE_BEARER',
  'BRAID_TANGLE_AUTH',
  'BRAID_TANGLE_API_KEY',
  'BRAID_TANGLE_BEARER',
  'BRAID_TANGLE_CREDENTIAL_REF',
  'BRAID_TANGLE_SANDBOX_AUTH',
  'BRAID_TANGLE_SANDBOX_API_KEY',
  'BRAID_TANGLE_SANDBOX_BEARER',
  'BRAID_TANGLE_SANDBOX_CLEANUP_API_KEY',
  'BRAID_TANGLE_SANDBOX_CREDENTIAL_REF',
  'BRAID_TANGLE_SANDBOX_MODEL_API_KEY',
  'TANGLE_API_KEY',
])

function isSecretKey(key) {
  const normalized = key.replaceAll(/[-_]/gu, '').toLowerCase()
  return secretKeys.has(normalized)
}

export function secretValues(environment = process.env) {
  const explicitSecrets = [...bridgeSecretEnvironmentKeys, ...braidLiveSecretEnvironmentKeys]
    .map((key) => environment?.[key])
    .filter((value) => typeof value === 'string' && value.length > 0)
  return collectCredentialSecrets(environment, explicitSecrets)
}

export function withoutBridgeSecrets(environment = process.env) {
  const childEnvironment = { ...environment }
  for (const key of bridgeSecretEnvironmentKeys) delete childEnvironment[key]
  return childEnvironment
}

export function withoutBraidLiveSecrets(environment = process.env) {
  const childEnvironment = { ...environment }
  for (const key of braidLiveSecretEnvironmentKeys) delete childEnvironment[key]
  return childEnvironment
}

export function redactString(value, secrets = secretValues()) {
  const secretList = [...new Set(secrets)].filter(
    (secret) => typeof secret === 'string' && secret.length > 0,
  )
  const valueWithoutSecrets = secretList.reduce(
    (current, secret) => current.split(secret).join('[redacted]'),
    value,
  )
  return valueWithoutSecrets
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/giu, '$1[redacted]@')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/gu, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, '[redacted]')
    .replace(
      /((?:token|access[-_ ]*token|refresh[-_ ]*token|api[-_ ]*key|secret|client[-_ ]*secret|password|authorization|credential)\s*[:=]\s*)[^,\s;&#]+/giu,
      '$1[redacted]',
    )
    .replace(
      /([?&](?:token|access[-_]?token|refresh[-_]?token|api[-_]?key|secret|client[-_]?secret|password|authorization|credential)=)[^&\s#]+/giu,
      '$1[redacted]',
    )
}

export function evidenceValue(value, key = '', depth = 0, secrets = secretValues()) {
  if (isSecretKey(key)) return '[redacted]'
  if (typeof value === 'string') return redactString(value, secrets)
  if (value === null || typeof value !== 'object') return value
  if (depth > 8) return '[depth-limited]'
  if (Array.isArray(value)) return value.map((item) => evidenceValue(item, key, depth + 1, secrets))
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      evidenceValue(entryValue, entryKey, depth + 1, secrets),
    ]),
  )
}
