import { connectionEndpoint } from '../connections/production-connection-endpoints.js'
import type { PreparedExecution } from './prepared-execution.js'
import type {
  ProductionBackendResolverOptions,
  ProductionExecutionSelection,
} from './production-backend-common.js'
import {
  prepareCliBridgeConnection,
  resolveCliBridgeBackend,
  type PreparedCliBridgeConnection,
} from './production-cli-bridge-backend.js'
import { resolveTangleInferenceBackend } from './production-tangle-inference-backend.js'
import { resolveTangleSandboxBackend } from './production-tangle-sandbox-backend.js'
import type { ExecuteTurnInput } from '../../ports/execution.js'

export type {
  ProductionBackendResolverOptions,
  ProductionExecutionSelection,
  ProductionExecutionSelector,
} from './production-backend-common.js'

/** Resolve one exact connection without starting a remote environment or paid model call. */
export function createProductionBackendResolver(
  options: ProductionBackendResolverOptions,
): (input: ExecuteTurnInput) => Promise<PreparedExecution> {
  return async (input) => {
    const selected = await options.select(input)
    const selection =
      input.connectionId === undefined
        ? selected
        : { ...selected, connection: { connectionId: input.connectionId } }
    return resolveProductionBackend(options, input, selection)
  }
}

export async function resolveProductionBackend(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
  selection: ProductionExecutionSelection,
): Promise<PreparedExecution> {
  const record = options.connections.select(selection.connection).record

  switch (record.kind) {
    case 'cli-bridge':
      return resolveCliBridgeBackend(
        options,
        input,
        selection,
        record.id,
        connectionEndpoint(record, options),
      )
    case 'tangle-inference':
      return resolveTangleInferenceBackend(
        options,
        input,
        selection,
        record.id,
        connectionEndpoint(record, options),
      )
    case 'tangle-sandbox':
      return resolveTangleSandboxBackend(options, input, selection, record.id)
  }
}

/** Resolve the secret-bearing CLI-Bridge plan without dispatching a run. */
export async function resolveProductionCliBridgeConnection(
  options: ProductionBackendResolverOptions,
  input: ExecuteTurnInput,
): Promise<PreparedCliBridgeConnection> {
  const selected = await options.select(input)
  const selection =
    input.connectionId === undefined
      ? selected
      : { ...selected, connection: { connectionId: input.connectionId } }
  const record = options.connections.select(selection.connection).record
  if (record.kind !== 'cli-bridge') {
    throw new Error('The retained CLI Bridge port received another connection kind')
  }
  return prepareCliBridgeConnection(
    options,
    input,
    selection,
    record.id,
    connectionEndpoint(record, options),
  )
}
