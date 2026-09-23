import type { ConnectionKind } from './connections.js'

export interface ProviderSetupSpec {
  readonly kind: ConnectionKind
  readonly title: string
  readonly requiresEndpoint: boolean
  readonly acceptsAccount: boolean
  readonly placement: 'local' | 'inference' | 'sandbox'
  readonly credentialDescription: string
}

export const CLI_BRIDGE_SETUP: ProviderSetupSpec = Object.freeze({
  kind: 'cli-bridge',
  title: 'CLI Bridge',
  requiresEndpoint: true,
  acceptsAccount: false,
  placement: 'local',
  credentialDescription: 'optional operating-system credential or environment reference',
})

export const TANGLE_INFERENCE_SETUP: ProviderSetupSpec = Object.freeze({
  kind: 'tangle-inference',
  title: 'Tangle inference',
  requiresEndpoint: false,
  acceptsAccount: true,
  placement: 'inference',
  credentialDescription: 'Tangle account credential reference',
})

export const TANGLE_SANDBOX_SETUP: ProviderSetupSpec = Object.freeze({
  kind: 'tangle-sandbox',
  title: 'Tangle sandbox',
  requiresEndpoint: false,
  acceptsAccount: true,
  placement: 'sandbox',
  credentialDescription: 'Tangle account credential reference',
})
