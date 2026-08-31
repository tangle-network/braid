import type { AgentProfile, HarnessType } from '@tangle-network/agent-interface'
import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionCatalog, ConnectionSelectionInput } from '../../app/connections.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import type { ConnectionId } from '../../domain/ids.js'
import { snapshotAgentProfile } from '../agent-interface/profile-runtime.js'
import type { ProductionConnectionOptions } from '../connections/production-connection-types.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'

/** Require the admission identity before a provider can dispatch a retained turn. */
export function exactTurnId(input: Pick<ExecuteTurnInput, 'turnId'>): string {
  if (typeof input.turnId !== 'string' || input.turnId.trim().length === 0) {
    throw new Error('Retained execution requires the canonical admitted turn identity')
  }
  return input.turnId
}

export interface ProductionExecutionSelection {
  readonly connection: ConnectionSelectionInput
  readonly model?: string
  readonly runner?: HarnessType
}

export type ProductionExecutionSelector = (
  input: ExecuteTurnInput,
) => ProductionExecutionSelection | Promise<ProductionExecutionSelection>

export interface ProductionBackendResolverOptions extends ProductionConnectionOptions {
  readonly connections: ConnectionCatalog
  readonly select: ProductionExecutionSelector
  readonly workspaceCwd?: string
}

export async function exactExecutionProfile(
  source: Readonly<AgentProfile>,
  selection: ProductionExecutionSelection,
  connectionId: ConnectionId,
  options: { readonly requireProvider?: boolean } = {},
): Promise<AgentProfile> {
  const profile = snapshotAgentProfile(source)
  const model = requiredProfileModel(profile, connectionId)
  const runner = requiredProfileRunner(profile, connectionId)
  const { cleanModelId } = await import('@tangle-network/agent-runtime')
  const selectedModel = cleanModelId(selection.model)
  if (selectedModel !== undefined && selectedModel !== model) {
    throw new ConnectionError(
      'CONNECTION_MODEL_HARNESS_MISMATCH',
      `Run model=${selectedModel} conflicts with AgentProfile.model.default=${model}; update the AgentProfile instead of overriding execution.`,
      { connectionId },
    )
  }
  if (selection.runner !== undefined && selection.runner !== runner) {
    throw new ConnectionError(
      'CONNECTION_MODEL_HARNESS_MISMATCH',
      `Run runner=${selection.runner} conflicts with AgentProfile.harness=${runner}; update the AgentProfile instead of overriding execution.`,
      { connectionId },
    )
  }
  if (options.requireProvider !== false && !profile.model?.provider?.trim()) {
    throw new ConnectionError(
      'CONNECTION_MODEL_REQUIRED',
      'AgentProfile.model.provider must identify the model provider before execution',
      { connectionId },
    )
  }
  return profile
}

export function requiredProfileModel(
  profile: Readonly<AgentProfile>,
  connectionId: ConnectionId,
): string {
  const value = profile.model?.default?.trim()
  if (!value) {
    throw new ConnectionError(
      'CONNECTION_MODEL_REQUIRED',
      'The selected AgentProfile requires a non-empty model id',
      { connectionId },
    )
  }
  return value
}

export function requiredProfileRunner(
  profile: Readonly<AgentProfile>,
  connectionId: ConnectionId,
): HarnessType {
  if (profile.harness === undefined) {
    throw new ConnectionError(
      'CONNECTION_MODEL_HARNESS_MISMATCH',
      'AgentProfile.harness must identify the runner before execution',
      { connectionId },
    )
  }
  return profile.harness
}

export function requiredWorkspaceCwd(
  inputRoot: string | undefined,
  configuredRoot: string | undefined,
): string {
  const workspace = inputRoot ?? configuredRoot
  if (workspace === undefined || workspace.length === 0) {
    throw new ConnectionError(
      'CONNECTION_WORKSPACE_REQUIRED',
      'The production execution path requires the canonical workspace root',
    )
  }
  return workspace
}

export function safeExecutionId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._:-]/gu, '-')
  if (value.length > 0 && safe === value && value.length <= 128) return value
  const readable = safe || 'run'
  const suffix = canonicalDigest(value).slice('sha256:'.length, 'sha256:'.length + 32)
  return `${readable.slice(0, 95)}-${suffix}`
}

/** Build a readable provider key without collisions or overlong truncation. */
export function stableProviderId(prefix: string, value: string): string {
  const readable = `${prefix}${safeExecutionId(value)}`
  if (readable.length <= 128) return readable
  const suffix = canonicalDigest({ prefix, value }).slice('sha256:'.length, 'sha256:'.length + 32)
  return `${readable.slice(0, 95)}-${suffix}`
}

export function freezeExecution<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeExecution(child)
    Object.freeze(value)
  }
  return value
}

export function connectionRecord(
  connectionId: ConnectionId,
  options: ProductionBackendResolverOptions,
): ConnectionRecord {
  const record = options.connections.get(connectionId)
  if (!record) {
    throw new ConnectionError('CONNECTION_NOT_FOUND', 'The selected connection does not exist', {
      connectionId,
    })
  }
  return record
}
