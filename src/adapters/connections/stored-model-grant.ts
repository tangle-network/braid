import {
  intersectProxySecretScopes,
  isProxySecretScopeAttenuation,
  mergeProxySecretBindings,
  ProxySecretsSchema,
  type CreateAgentEnvironmentInput,
  type ProxySecretBinding,
} from '@tangle-network/agent-interface/environment-provider'
import { ConnectionError } from '../../app/connection-errors.js'
import { storedModelProxyBinding } from '../../domain/connection-credential-references.js'
import type {
  ConnectionModelCredentialStoredApi,
  ConnectionRecord,
} from '../../domain/entities-core.js'
import { readConnectionCredential } from './production-connection-credentials.js'
import { connectionEndpoint } from './production-connection-endpoints.js'
import type { ProductionConnectionOptions } from './production-connection-types.js'

/** Resolve public policy only. Sandbox checks it against the current issuer again when granting it. */
export async function storedModelGrant(
  reference: ConnectionModelCredentialStoredApi,
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
  input: Readonly<CreateAgentEnvironmentInput>,
): Promise<ProxySecretBinding> {
  const root = storedModelProxyBinding(reference)
  const name = reference.apiKeyEnv
  const invalid = () =>
    new ConnectionError(
      'CONNECTION_CREDENTIAL_INVALID',
      'The stored model secret needs a bearer grant for this name and model API.',
      { connectionId: record.id },
    )
  const authored = mergeProxySecretBindings(
    typeof input.profile === 'object' ? input.profile.proxySecrets : undefined,
    input.proxySecrets,
  ).find((binding) => binding.envName === name)
  if (authored) {
    if (
      authored.secretRef.key !== name ||
      authored.presentation.type !== 'bearer' ||
      !isProxySecretScopeAttenuation(root, authored)
    )
      throw invalid()
    return authored
  }

  // An injected Sandbox client may own its credential itself. The explicit endpoint
  // binding also works with older issuers that only offer the create API.
  if (!options.credentials || !options.credentialRefResolver) return root
  const endpoint = connectionEndpoint(record, options)
  const credential = await readConnectionCredential(record, options, endpoint)
  const url = new URL(endpoint)
  const prefix = url.pathname.replace(/\/$/u, '').replace(/\/v1$/u, '')
  url.pathname = `${prefix}/v1/secrets`
  const response = await (options.fetch ?? fetch)(url, {
    headers: { authorization: `Bearer ${credential}`, accept: 'application/json' },
    redirect: 'error',
    signal: input.signal ?? null,
  })
  if ([403, 404, 405].includes(response.status)) {
    await response.body?.cancel()
    return root
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new ConnectionError(
      'CONNECTION_CREDENTIAL_UNAVAILABLE',
      `Sandbox could not read the stored model grant (HTTP ${response.status}).`,
      { connectionId: record.id },
    )
  }
  const metadata = (await response.json().catch(() => {
    throw invalid()
  })) as { secrets?: Array<{ name?: unknown; proxySecrets?: unknown }> }
  const rows = Array.isArray(metadata?.secrets)
    ? metadata.secrets.filter((row) => row?.name === name)
    : []
  if (rows.length !== 1) throw invalid()
  const policy = rows[0]?.proxySecrets
  if (policy === undefined) return root
  const parsed = ProxySecretsSchema.safeParse(policy)
  const binding = parsed.success
    ? parsed.data.find((entry) => entry.envName === name && entry.secretRef.key === name)
    : undefined
  if (binding?.presentation.type !== 'bearer') throw invalid()
  const scope = intersectProxySecretScopes(root, binding)
  if (!scope) throw invalid()
  return { ...binding, ...scope }
}
