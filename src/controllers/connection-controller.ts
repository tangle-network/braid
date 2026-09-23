import type { AgentProfile, AgentProfileValidationResult } from '@tangle-network/agent-interface'
import { unsupportedProfileDimensions } from '../adapters/connections/capability-report.js'
import {
  type ConnectionCapabilitySnapshot,
  type ConnectionHealth,
  type ConnectionProviderPort,
  type ConnectionRecord,
  type ConnectionSetupInput,
  connectionCredentialReferences,
  createConnectionRecord,
  updateConnectionHealth,
  withCapabilityDigest,
} from '../connection/connections.js'
import { type ConnectionRegistry, type ConnectionUsage } from '../connection/connection-registry.js'
import { type CredentialStore, parseCredentialReference } from '../connection/credentials.js'
import type { ConnectionRecordPersistence } from '../connection/connection-persistence.js'
import { redactErrorMessage, redactProviderText } from '../connection/redaction.js'
import { validateCanonicalProfile } from '../profile/profile-validation.js'
import {
  ConnectionSetupCancelledError,
  ConnectionSetupTimeoutError,
  withConnectionSetupDeadline,
} from '../connection/setup-deadline.js'

export interface ConnectionViewModel {
  readonly id: string
  readonly kind: ConnectionRecord['kind']
  readonly name: string
  readonly endpoint?: string
  readonly account?: string
  readonly health?: ConnectionHealth
  readonly credentialConfigured: boolean
}

export interface ConnectionSetupResult {
  readonly connection: ConnectionViewModel
  readonly capabilities: ConnectionCapabilitySnapshot
}

function view(connection: ConnectionRecord): ConnectionViewModel {
  return Object.freeze({
    id: connection.id,
    kind: connection.kind,
    name: connection.name,
    ...(connection.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
    ...(connection.account === undefined ? {} : { account: connection.account }),
    ...(connection.lastHealth === undefined
      ? {}
      : { health: Object.freeze({ ...connection.lastHealth }) }),
    credentialConfigured: connectionCredentialReferences(connection).length > 0,
  })
}

export class ConnectionController {
  readonly #registry: ConnectionRegistry
  readonly #providers: ReadonlyMap<ConnectionRecord['kind'], ConnectionProviderPort>
  readonly #credentials: CredentialStore | undefined
  readonly #persistence: ConnectionRecordPersistence | undefined
  readonly #now: () => string
  readonly #setupTimeoutMs: number
  #mutationTail: Promise<void> = Promise.resolve()

  constructor(options: {
    readonly registry: ConnectionRegistry
    readonly providers: readonly ConnectionProviderPort[]
    readonly credentials?: CredentialStore
    readonly persistence?: ConnectionRecordPersistence
    readonly now: () => string
    readonly setupTimeoutMs?: number
  }) {
    this.#registry = options.registry
    this.#providers = new Map(options.providers.map((provider) => [provider.kind, provider]))
    this.#credentials = options.credentials
    this.#persistence = options.persistence
    this.#now = options.now
    this.#setupTimeoutMs = options.setupTimeoutMs ?? 10_000
  }

  list(): readonly ConnectionViewModel[] {
    return Object.freeze(this.#registry.list().map(view))
  }

  /** Load and validate persisted connections before a new process serves runs. */
  async restore(): Promise<readonly ConnectionViewModel[]> {
    if (this.#persistence === undefined) {
      throw new Error('Connection persistence is not configured')
    }
    const persistence = this.#persistence
    return this.#serialize(async () => {
      try {
        this.#registry.restore(await persistence.load())
        return this.list()
      } catch (error) {
        throw new Error(redactErrorMessage(error))
      }
    })
  }

  /**
   * Prove the connection before persisting it.
   *
   * Setup runs a bounded health check and a capability read first, so a typo'd or
   * unauthorized endpoint never becomes a saved connection that later flows look
   * up as configured. The proven capability snapshot is returned to the caller.
   */
  async setup(
    input: ConnectionSetupInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ConnectionSetupResult> {
    return this.#serialize(async () => {
      const previous = this.#registry.list()
      try {
        const candidate = createConnectionRecord(input)
        const provider = this.provider(candidate)
        const { health, capabilities } = await withConnectionSetupDeadline({
          timeoutMs: this.#setupTimeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          work: async (signal) => {
            const health = await provider.health(candidate, { signal })
            if (health.status !== 'healthy') {
              const detail =
                health.message === undefined ? undefined : redactProviderText(health.message)
              throw new Error(
                `Connection ${candidate.id} is not usable: provider health is ${health.status}${
                  detail === undefined ? '' : ` (${detail})`
                }`,
              )
            }
            const capabilities = withCapabilityDigest(
              await provider.capabilities(candidate, { signal }),
            )
            return { health, capabilities }
          },
        })
        const proven = this.#registry.save(updateConnectionHealth(candidate, health, this.#now()))
        await this.#persist()
        return Object.freeze({ connection: view(proven), capabilities })
      } catch (error) {
        this.#registry.restore(previous)
        if (error instanceof ConnectionSetupTimeoutError) throw error
        if (error instanceof ConnectionSetupCancelledError) throw error
        throw new Error(redactErrorMessage(error))
      }
    })
  }

  async health(
    id: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ConnectionViewModel> {
    return this.#serialize(async () => {
      const previous = this.#registry.list()
      try {
        const connection = this.require(id)
        const health = await this.provider(connection).health(
          connection,
          options.signal === undefined ? {} : { signal: options.signal },
        )
        const updated = this.#registry.save(updateConnectionHealth(connection, health, this.#now()))
        await this.#persist()
        return view(updated)
      } catch (error) {
        this.#registry.restore(previous)
        throw new Error(redactErrorMessage(error))
      }
    })
  }

  async capabilities(
    id: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ConnectionCapabilitySnapshot> {
    const connection = this.require(id)
    try {
      return withCapabilityDigest(
        await this.provider(connection).capabilities(
          connection,
          options.signal === undefined ? {} : { signal: options.signal },
        ),
      )
    } catch (error) {
      throw new Error(redactErrorMessage(error))
    }
  }

  async validateProfile(
    id: string,
    profile: Readonly<AgentProfile>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AgentProfileValidationResult> {
    const connection = this.require(id)
    const provider = this.provider(connection)
    const signalOptions = options.signal === undefined ? {} : { signal: options.signal }
    try {
      const capabilities = withCapabilityDigest(
        await provider.capabilities(connection, signalOptions),
      )
      const capabilityIssues = unsupportedProfileDimensions(
        capabilities.environment.profile,
        profile,
      ).map((dimension) => ({
        level: 'error' as const,
        code: 'UNSUPPORTED_PROFILE_DIMENSION',
        message: `The ${connection.kind} connection does not report support for ${dimension}`,
        path: dimension,
      }))
      const providerResult =
        provider.validateProfile === undefined
          ? { ok: true, issues: [] }
          : await provider.validateProfile(connection, profile, {
              capabilities,
              ...signalOptions,
            })
      return {
        ok: providerResult.ok && capabilityIssues.length === 0,
        issues: [...capabilityIssues, ...providerResult.issues],
        ...(providerResult.normalizedProfile === undefined
          ? {}
          : { normalizedProfile: providerResult.normalizedProfile }),
      }
    } catch (error) {
      throw new Error(redactErrorMessage(error))
    }
  }

  /**
   * Remove a connection and only then release credentials it exclusively owned.
   *
   * Reference counts come from the registry, not from the caller: an incomplete
   * caller-supplied usage list would delete a credential a sibling connection
   * still leases. Environment and session references are never deleted, because
   * Braid does not own them.
   */
  async remove(id: string, usage: ConnectionUsage): Promise<readonly string[]> {
    return this.#serialize(async () => {
      const previous = this.#registry.list()
      let changed = false
      try {
        const connection = this.require(id)
        const owned = connectionCredentialReferences(connection)
        this.#registry.remove(id, usage)
        changed = true
        await this.#persist()
        const released: string[] = []
        if (this.#credentials === undefined) return Object.freeze(released)
        const releasable: Array<{ readonly reference: string; readonly parsed: ReturnType<typeof parseCredentialReference> }> = []
        for (const reference of new Set(owned)) {
          if (this.#registry.credentialReferenceCount(reference) > 0) continue
          const parsed = parseCredentialReference(reference)
          if (parsed.kind === 'os') releasable.push({ reference, parsed })
        }
        if (releasable.length > 1) {
          if (this.#credentials.removeMany === undefined) {
            throw new Error('Credential store cannot release multiple references atomically')
          }
          await this.#credentials.removeMany(releasable.map((entry) => entry.parsed))
          released.push(...releasable.map((entry) => entry.reference))
        } else if (releasable.length === 1) {
          const [entry] = releasable
          if (entry === undefined) throw new Error('Credential release set was unexpectedly empty')
          await this.#credentials.remove(entry.parsed)
          released.push(entry.reference)
        }
        return Object.freeze(released)
      } catch (error) {
        if (changed) {
          this.#registry.restore(previous)
          try {
            await this.#persist()
          } catch (restoreError) {
            throw new Error(
              `${redactErrorMessage(error)}; connection restore failed: ${redactErrorMessage(restoreError)}`,
            )
          }
        }
        throw new Error(redactErrorMessage(error))
      }
    })
  }

  async #persist(): Promise<void> {
    if (this.#persistence === undefined) return
    await this.#persistence.save(this.#registry.list())
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#mutationTail.then(operation, operation)
    this.#mutationTail = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }

  private require(id: string): ConnectionRecord {
    const connection = this.#registry.get(id)
    if (connection === undefined) throw new Error(`Connection ${id} does not exist`)
    return connection
  }

  private provider(connection: ConnectionRecord): ConnectionProviderPort {
    const provider = this.#providers.get(connection.kind)
    if (provider === undefined) {
      throw new Error(`No provider adapter is installed for ${connection.kind}`)
    }
    return provider
  }
}
