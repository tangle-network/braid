import { canonicalAgentProfileDigest, type AgentProfile } from '@tangle-network/agent-interface'
import type { ConnectionProviderPort, ConnectionRecord } from '../connection/connections.js'
import type { WorkspaceInspectionFile, WorkspaceIdentity } from '../connection/workspace-trust.js'
import type { ProfileDocument } from '../profile/profile-sources.js'
import type { RunAdmissionController, RunIdentifiers } from '../controllers/run-admission.js'

export interface ApplicationAdmissionInput extends RunIdentifiers {
  readonly runId: string
  readonly profile: Readonly<AgentProfile>
  readonly text: string
  readonly workspace: string
  readonly signal: AbortSignal
}

export interface ApplicationAdmissionGate {
  admit(input: ApplicationAdmissionInput): Promise<Readonly<AgentProfile>>
}

export interface RunAdmissionGateOptions {
  readonly admission: RunAdmissionController
  readonly provider: ConnectionProviderPort
  readonly connection: ConnectionRecord
  readonly source: ProfileDocument
  readonly workspaceAuthority?: Readonly<{
    readonly identity: WorkspaceIdentity
    readonly files: readonly WorkspaceInspectionFile[]
  }>
}

/** The only application-to-runtime admission path used by the real composition. */
export class RunAdmissionGate implements ApplicationAdmissionGate {
  readonly #admission: RunAdmissionController
  readonly #provider: ConnectionProviderPort
  readonly #connection: ConnectionRecord
  readonly #source: ProfileDocument
  readonly #workspaceAuthority: RunAdmissionGateOptions['workspaceAuthority']

  constructor(options: RunAdmissionGateOptions) {
    this.#admission = options.admission
    this.#provider = options.provider
    this.#connection = options.connection
    this.#source = options.source
    this.#workspaceAuthority = options.workspaceAuthority
  }

  async admit(input: ApplicationAdmissionInput): Promise<Readonly<AgentProfile>> {
    if (canonicalAgentProfileDigest(input.profile) !== this.#source.profileDigest) {
      throw new Error('The application profile differs from its admitted profile document')
    }
    const health = await this.#provider.health(this.#connection, { signal: input.signal })
    if (health.status !== 'healthy') {
      throw new Error(`Connection ${this.#connection.id} is not healthy: ${health.status}`)
    }
    const prepared = await this.#admission.prepare({
      identifiers: {
        operationId: input.operationId,
        turnId: input.turnId,
        branchId: input.branchId,
        conversationId: input.conversationId,
      },
      source: this.#source,
      connection: this.#connection,
      ...(this.#workspaceAuthority === undefined
        ? {}
        : {
            workspace: {
              identity: input.workspace,
              authority: this.#workspaceAuthority,
            },
          }),
      signal: input.signal,
    })
    const result = await this.#admission.admit({
      prepared,
      connection: this.#connection,
      signal: input.signal,
    })
    return result.preAdmission.effectiveProfile
  }
}

export class UnconfiguredAdmissionGate implements ApplicationAdmissionGate {
  async admit(): Promise<Readonly<AgentProfile>> {
    throw new Error('No Braid connection is configured')
  }
}
