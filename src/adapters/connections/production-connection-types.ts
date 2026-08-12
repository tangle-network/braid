import type { AgentExactRunControlRef, AgentProfile } from '@tangle-network/agent-interface'
import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface/environment-provider'
import type { SandboxClientLike } from '@tangle-network/agent-provider-tangle'
import type { RouterTransportConfig } from '@tangle-network/agent-runtime/kernel'
import type {
  ConnectionHealth,
  ConnectionKind,
  ConnectionModelVerification,
  ConnectionRecord,
  IsoDateTime,
} from '../../domain/entities.js'
import type { ConnectionId, CredentialRefId } from '../../domain/ids.js'
import type { CredentialPort, CredentialRef } from '../../ports/credentials.js'

export const DEFAULT_TANGLE_SANDBOX_ENDPOINT = 'https://sandbox.tangle.tools'

export type ConnectionCapabilityAction =
  | 'stream'
  | 'replay'
  | 'detach'
  | 'continue-session'
  | 'list-sessions'
  | 'session-messages'
  | 'checkpoint'
  | 'fork'
  | 'placement'
  | 'usage'
  | 'respond-interaction'

export interface ConnectionRuntimeCapabilities {
  readonly backend: 'chat' | 'executor'
  readonly streaming: Readonly<{
    live: boolean
    replay: boolean
    detach: boolean
    turnIdempotency: boolean
  }>
  readonly sessions: Readonly<{
    continue: boolean
    list: boolean
    messages: boolean
  }>
  readonly interactions: Readonly<{
    originate: boolean
    respond: boolean
  }>
}

export interface ConnectionProviderMethods {
  readonly create: boolean
  readonly get: boolean | 'unknown'
  readonly list: boolean | 'unknown'
  readonly respondToInteraction: boolean | 'unknown'
}

export interface ConnectionCapabilityReport {
  readonly connectionId: ConnectionId
  readonly kind: ConnectionKind
  readonly runtime: ConnectionRuntimeCapabilities
  readonly environment?: AgentEnvironmentCapabilities
  readonly providerMethods: ConnectionProviderMethods
  readonly actions: Readonly<Record<ConnectionCapabilityAction, boolean>>
}

export interface SandboxClientFactoryInput {
  readonly record: ConnectionRecord
  readonly endpoint: string
  readonly apiKey: string
  readonly signal?: AbortSignal
}

export type SandboxClientFactory = (
  input: SandboxClientFactoryInput,
) => SandboxClientLike | Promise<SandboxClientLike>

export interface TangleRetainedControlLookupInput {
  readonly connectionId: ConnectionId
  readonly braidRunId: string
  readonly providerSessionId: string
  readonly executionId: string
  readonly environmentIdempotencyKey: string
  readonly signal?: AbortSignal
}

/** Provider-backed lookup for a dispatch whose acknowledgement was not journaled. */
export type TangleRetainedControlLookup = (
  input: TangleRetainedControlLookupInput,
) => Promise<AgentExactRunControlRef | null>

export interface ProductionConnectionOptions {
  readonly credentials?: CredentialPort
  /** Map Braid's durable credential id to the credential-port's opaque ref. */
  readonly credentialRefResolver?: (ref: CredentialRefId) => CredentialRef | Promise<CredentialRef>
  readonly fetch?: typeof fetch
  /** Injectable Runtime Router transport for tests and embedded deployments. */
  readonly routerComplete?: RouterTransportConfig['complete']
  readonly defaultInferenceEndpoint?: string
  readonly defaultSandboxEndpoint?: string
  /** Explicit product policy for a non-loopback cleartext endpoint. */
  readonly trustedTransportPolicy?: (input: {
    readonly record: ConnectionRecord
    readonly endpoint: string
  }) => boolean
  readonly sandboxClient?: SandboxClientLike
  readonly sandboxClientFactory?: SandboxClientFactory
  readonly tangleRetainedControlLookup?: TangleRetainedControlLookup
  readonly now?: () => IsoDateTime
}

export interface ConnectionHealthOptions {
  readonly signal?: AbortSignal
  readonly now?: () => IsoDateTime
}

export interface ConnectionModelVerificationOptions {
  readonly signal?: AbortSignal
  readonly now?: () => IsoDateTime
  /** Exact selected profile required for a bounded CLI Bridge model request. */
  readonly profile?: Readonly<AgentProfile>
}

export interface ProductionConnectionAdapter {
  readonly record: ConnectionRecord
  capabilities(): Promise<ConnectionCapabilityReport>
  health(options?: ConnectionHealthOptions): Promise<ConnectionHealth>
  verifyModel?(
    model: string,
    options?: ConnectionModelVerificationOptions,
  ): Promise<ConnectionModelVerification>
}
