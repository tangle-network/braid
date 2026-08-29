import { harnessTypeSchema, type AgentProfile } from '@tangle-network/agent-interface'
import { materializeBridgeModelRoute } from '../adapters/connections/cli-bridge-model-route.js'
import { nitroVerifiersForConnection } from '../adapters/connections/nitro-confidential-attestation.js'
import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import {
  connectionEndpoint,
  createTangleEnvironmentProvider,
  createTangleWorkspaceBranchingProvider,
} from '../adapters/connections/production-connections.js'
import {
  AgentRuntimeExecutionPort,
  type AgentTurnBackendResolver,
} from '../adapters/runtime/agent-runtime-execution.js'
import { createCliBridgeContextTransferPort } from '../adapters/runtime/cli-bridge-context-transfer.js'
import { CliBridgeRetainedExecutionPort } from '../adapters/runtime/cli-bridge-retained-execution.js'
import { ModeRoutingExecutionPort } from '../adapters/runtime/mode-routing-execution.js'
import { NativeInteractiveRunBroker } from '../adapters/runtime/native-interactive-run-broker.js'
import {
  createProductionBackendResolver,
  type ProductionBackendResolverOptions,
  resolveProductionCliBridgeConnection,
  resolveProductionTangleRetainedConnection,
} from '../adapters/runtime/production-backend-resolver.js'
import { prepareCliBridgeProviderRoute } from '../adapters/runtime/production-cli-bridge-backend.js'
import { RuntimeSupervisorController } from '../adapters/runtime/supervisor-control.js'
import { TangleRetainedExecutionPort } from '../adapters/runtime/tangle-retained-execution.js'
import { TangleRetainedInteractiveExecutionPort } from '../adapters/runtime/tangle-retained-interactive-execution.js'
import type { ConnectionRecord } from '../domain/entities.js'
import type {
  ExecuteTurnInput,
  ExecutionPort,
  RetainedExecutionRecoveryContext,
  RetainedRunAdmissionRecord,
} from '../ports/execution.js'
import type { NativeInteractiveExecutionControl } from '../ports/native-interactive-execution.js'
import { ConnectionError } from './connection-errors.js'
import { ConnectionRegistry } from './connections.js'
import { assertValidProfile } from './profile-validation.js'

export type ProductionCompositionErrorCode =
  | 'PRODUCTION_CONFIGURATION_REQUIRED'
  | 'PRODUCTION_PROFILE_INVALID'
  | 'PRODUCTION_CONNECTION_REQUIRED'
  | 'PRODUCTION_CONNECTION_INVALID'
  | 'PRODUCTION_CONNECTION_NOT_FOUND'
  | 'PRODUCTION_CONNECTION_UNSUPPORTED'
  | 'PRODUCTION_FIXTURE_FORBIDDEN'

export class ProductionCompositionError extends Error {
  readonly code: ProductionCompositionErrorCode

  constructor(code: ProductionCompositionErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ProductionCompositionError'
    this.code = code
  }
}

export interface ProductionCompositionConfig {
  /** The complete canonical profile selected for this process. */
  readonly profile: Readonly<AgentProfile>
  /** Candidate connections loaded from the selected configuration source. */
  readonly connections: readonly ConnectionRecord[]
  /** Exact connection identity; names and provider kinds are never guessed. */
  readonly connectionId: string
  /** Canonical workspace root used by provider environment creation. */
  readonly workspaceRoot?: string
  /** Protected headless SQLite key-file path, absolute or relative to the config directory. */
  readonly databaseKeyFile?: string
  /** Published provider construction options, including credential resolution. */
  readonly connectionOptions?: ProductionConnectionOptions
}

export interface ProductionComposition {
  readonly profile: Readonly<AgentProfile>
  readonly connections: ConnectionRegistry
  readonly connection: ConnectionRecord
  readonly execution: ExecutionPort
  readonly nativeInteractive?: NativeInteractiveExecutionControl
  readonly supervisorController?: RuntimeSupervisorController
  readonly backendResolver: AgentTurnBackendResolver
}

const SUPPORTED_CONNECTION_KINDS = new Set<ConnectionRecord['kind']>([
  'cli-bridge',
  'tangle-inference',
  'tangle-sandbox',
])

export function createProductionComposition(
  config: ProductionCompositionConfig,
  liveConnections?: ConnectionRegistry,
): ProductionComposition {
  if (!config || config.profile === undefined) {
    throw new ProductionCompositionError(
      'PRODUCTION_CONFIGURATION_REQUIRED',
      'Production startup requires a canonical profile and one connection',
    )
  }

  let profile: Readonly<AgentProfile>
  try {
    profile = assertValidProfile(config.profile)
  } catch (error) {
    throw new ProductionCompositionError(
      'PRODUCTION_PROFILE_INVALID',
      'The selected profile is not a valid canonical AgentProfile',
      error,
    )
  }

  if (!Array.isArray(config.connections) || config.connections.length === 0) {
    throw new ProductionCompositionError(
      'PRODUCTION_CONNECTION_REQUIRED',
      'Production startup requires at least one configured connection',
    )
  }
  for (const record of config.connections) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new ProductionCompositionError(
        'PRODUCTION_CONNECTION_INVALID',
        'Every production connection must be an object without secret material',
      )
    }
    const candidate = record as unknown as {
      readonly id?: unknown
      readonly kind?: unknown
    }
    if (typeof candidate.kind !== 'string') {
      throw new ProductionCompositionError(
        'PRODUCTION_CONNECTION_INVALID',
        'Every production connection must declare a provider kind',
      )
    }
    if (!SUPPORTED_CONNECTION_KINDS.has(candidate.kind as ConnectionRecord['kind'])) {
      throw new ProductionCompositionError(
        'PRODUCTION_CONNECTION_UNSUPPORTED',
        `Connection ${String(candidate.id)} uses an unsupported provider kind`,
      )
    }
  }

  let validatedConnections: ConnectionRegistry
  try {
    validatedConnections = new ConnectionRegistry(config.connections)
    for (const record of validatedConnections.list()) {
      connectionEndpoint(record, config.connectionOptions)
    }
  } catch (error) {
    throw new ProductionCompositionError(
      'PRODUCTION_CONNECTION_INVALID',
      'The production connection configuration is invalid or contains secret material',
      error,
    )
  }
  const connections = liveConnections ?? validatedConnections
  if (liveConnections !== undefined) {
    const configured = validatedConnections.list()
    const live = liveConnections.list()
    if (
      configured.length !== live.length ||
      configured.some((record) => liveConnections.get(record.id)?.updatedAt !== record.updatedAt)
    ) {
      throw new ProductionCompositionError(
        'PRODUCTION_CONNECTION_INVALID',
        'The live connection catalog does not match the production configuration',
      )
    }
  }

  let connection: ConnectionRecord
  try {
    connection = connections.select({ connectionId: config.connectionId }).record
  } catch (error) {
    if (error instanceof ConnectionError && error.code === 'CONNECTION_NOT_FOUND') {
      throw new ProductionCompositionError(
        'PRODUCTION_CONNECTION_NOT_FOUND',
        'The configured production connection does not exist',
        error,
      )
    }
    throw new ProductionCompositionError(
      'PRODUCTION_CONNECTION_REQUIRED',
      'Production startup requires an exact connection id',
      error,
    )
  }

  const resolverOptionsBase: ProductionBackendResolverOptions = {
    ...(config.connectionOptions ?? {}),
    connections,
    ...(config.workspaceRoot === undefined ? {} : { workspaceCwd: config.workspaceRoot }),
    select: () => ({
      connection: {
        connectionId: connection.id,
        expectedKind: connection.kind,
        expectedUpdatedAt: connection.updatedAt,
      },
    }),
  }
  const confidential = nitroVerifiersForConnection(connection, resolverOptionsBase)
  const resolverOptions: ProductionBackendResolverOptions = {
    ...resolverOptionsBase,
    ...(confidential?.tangle === undefined
      ? {}
      : { tangleConfidentialAttestationVerifier: confidential.tangle }),
    ...(confidential?.canonical === undefined
      ? {}
      : { confidentialAttestationVerifier: confidential.canonical }),
  }
  const backendResolver = createProductionBackendResolver(resolverOptions)
  const supervisorController =
    connection.kind === 'tangle-sandbox'
      ? new RuntimeSupervisorController({
          providers: (signal) =>
            createTangleEnvironmentProvider(connection, resolverOptions, signal),
        })
      : undefined
  const workspaceBranchingProvider =
    connection.kind === 'tangle-sandbox'
      ? createTangleWorkspaceBranchingProvider(connection, resolverOptions)
      : undefined
  const recoveryInput = (
    runId: string,
    providerSessionId: string | undefined,
    recovery: RetainedExecutionRecoveryContext,
    signal?: AbortSignal,
  ): ExecuteTurnInput => {
    const requested = recovery.receipt?.requested
    const admissionSessionId = retainedAdmissionSessionId(recovery.retainedAdmission)
    const sessionId = providerSessionId ?? admissionSessionId
    const workspaceRoot = recovery.workspaceRoot ?? config.workspaceRoot
    return {
      operationId: recovery.receipt?.operationId ?? `recover-${runId}`,
      runId,
      text: requested?.text ?? '',
      profile: requested?.profile ?? profile,
      ...(requested?.mode === undefined ? {} : { mode: requested.mode }),
      ...(requested?.interactions === undefined ? {} : { interactions: requested.interactions }),
      connectionId: requested?.connectionId ?? connection.id,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      signal: signal ?? new AbortController().signal,
    }
  }
  let nativeInteractive: NativeInteractiveExecutionControl | undefined
  const execution = (() => {
    if (connection.kind === 'cli-bridge') {
      const context = createCliBridgeContextTransferPort({
        resolve: (request) => {
          const destination = request.plan.destination
          const runner = harnessTypeSchema.safeParse(destination.runner)
          if (!runner.success || destination.model === undefined) {
            throw new Error(
              'The portable context destination requires a supported runner and exact model',
            )
          }
          return prepareCliBridgeProviderRoute(
            resolverOptions,
            connection.id,
            connectionEndpoint(connection, resolverOptions),
            runner.data,
            materializeBridgeModelRoute(runner.data, destination.model),
          )
        },
      })
      return new CliBridgeRetainedExecutionPort({
        context,
        resolve: (input) => resolveProductionCliBridgeConnection(resolverOptions, input),
        recover: ({ runId, providerSessionId, signal, ...recovery }) =>
          resolveProductionCliBridgeConnection(
            resolverOptions,
            recoveryInput(runId, providerSessionId, recovery, signal),
          ),
      })
    }
    if (
      connection.kind === 'tangle-sandbox' &&
      connection.providerOptions.lifecycle === 'retained'
    ) {
      const headless = new TangleRetainedExecutionPort({
        resolve: (input) => resolveProductionTangleRetainedConnection(resolverOptions, input),
        recover: ({ runId, providerSessionId, signal, ...recovery }) =>
          resolveProductionTangleRetainedConnection(
            resolverOptions,
            recoveryInput(runId, providerSessionId, recovery, signal),
          ),
        ...(workspaceBranchingProvider === undefined ? {} : { workspaceBranchingProvider }),
        ...(resolverOptions.confidentialAttestationVerifier === undefined
          ? {}
          : { confidentialAttestationVerifier: resolverOptions.confidentialAttestationVerifier }),
      })
      const broker = new NativeInteractiveRunBroker()
      const interactive = new TangleRetainedInteractiveExecutionPort({
        resolve: (input) => resolveProductionTangleRetainedConnection(resolverOptions, input),
        recover: (input) => resolveProductionTangleRetainedConnection(resolverOptions, input),
        broker,
        ...(workspaceBranchingProvider === undefined ? {} : { workspaceBranchingProvider }),
        ...(resolverOptions.confidentialAttestationVerifier === undefined
          ? {}
          : { confidentialAttestationVerifier: resolverOptions.confidentialAttestationVerifier }),
      })
      nativeInteractive = broker
      return new ModeRoutingExecutionPort({ headless, interactive })
    }
    return new AgentRuntimeExecutionPort(backendResolver, undefined, {
      ...(workspaceBranchingProvider === undefined ? {} : { workspaceBranchingProvider }),
      ...(resolverOptions.confidentialAttestationVerifier === undefined
        ? {}
        : { confidentialAttestationVerifier: resolverOptions.confidentialAttestationVerifier }),
    })
  })()

  return Object.freeze({
    profile,
    connections,
    connection,
    execution,
    ...(nativeInteractive === undefined ? {} : { nativeInteractive }),
    ...(supervisorController === undefined ? {} : { supervisorController }),
    backendResolver,
  })
}

function retainedAdmissionSessionId(
  admission: RetainedRunAdmissionRecord | undefined,
): string | undefined {
  switch (admission?.phase) {
    case 'intent':
    case 'environment':
    case 'interactive_intent':
      return admission.sessionId
    case 'dispatched':
      return admission.controlRef.sessionId
    case 'interactive_environment':
      return admission.request.run.sessionId
    case 'interactive_started':
      return admission.ref.run.sessionId
    default:
      return undefined
  }
}
