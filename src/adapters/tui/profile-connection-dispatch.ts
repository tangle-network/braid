import type { AgentProfileSecurityPolicy } from '@tangle-network/agent-interface'
import type {
  ConnectionHealthOptions,
  ConnectionModelVerificationOptions,
  ProductionConnectionAdapter,
  ProductionConnectionOptions,
} from '../../adapters/connections/production-connections.js'
import type { BraidApplication } from '../../app/application.js'
import { ConnectionActionService, type ConnectionActions } from '../../app/connection-actions.js'
import type { ConnectionProbeFactory } from '../../app/connection-probe.js'
import { AppError } from '../../app/errors.js'
import { type ProfileActionOptions, ProfileActionService } from '../../app/profile-actions.js'
import type {
  ProfileDiscoveryInput,
  ProfileProvider,
  ProfileRecord as SourceProfileRecord,
} from '../../app/profiles.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'

export interface ProfileConnectionDispatchOptions {
  readonly profiles?: readonly SourceProfileRecord[]
  readonly discovery?: ProfileDiscoveryInput
  readonly provider?: ProfileProvider
  readonly securityPolicy?: AgentProfileSecurityPolicy
  readonly acceptedProviderWarningCodes?: readonly string[]
  readonly connections?: readonly ConnectionRecord[]
  readonly connectionCatalog?: () => readonly ConnectionRecord[]
  readonly connectionActionsFor?: (app: BraidApplication) => ConnectionActions
  readonly adapters?: ReadonlyMap<string, ProductionConnectionAdapter>
  readonly adapterFor?: (record: ConnectionRecord) => ProductionConnectionAdapter | undefined
  readonly probeFor?: ConnectionProbeFactory
  readonly productionConnection?: ProductionConnectionOptions
  readonly now?: () => string
  readonly onProfileSavePhase?: ProfileActionOptions['onSavePhase']
  readonly services?: ProfileConnectionDispatchServices
}

export interface ProfileConnectionDispatchServices {
  readonly profiles: ProfileActionService
  readonly connections: ConnectionActions
  readonly revision: () => number
}

export function createProfileConnectionDispatchServices(
  app: BraidApplication,
  options: ProfileConnectionDispatchOptions = {},
): ProfileConnectionDispatchServices {
  if (options.services !== undefined) return options.services
  const host = {
    state: () => app.state(),
    configuration: app.configuration,
    runtime: app.runtimeSelection,
  }
  const probeFor: ConnectionProbeFactory | undefined =
    options.probeFor ??
    ((record) =>
      options.adapterFor?.(record) ??
      options.adapters?.get(record.id) ??
      (options.productionConnection === undefined
        ? undefined
        : createLazyProductionConnectionAdapter(record, options.productionConnection)))
  return {
    profiles: new ProfileActionService({
      host,
      ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
      ...(options.discovery === undefined ? {} : { discovery: options.discovery }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.securityPolicy === undefined ? {} : { securityPolicy: options.securityPolicy }),
      ...(options.acceptedProviderWarningCodes === undefined
        ? {}
        : { acceptedProviderWarningCodes: options.acceptedProviderWarningCodes }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.onProfileSavePhase === undefined
        ? {}
        : { onSavePhase: options.onProfileSavePhase }),
    }),
    connections:
      options.connectionActionsFor?.(app) ??
      new ConnectionActionService({
        host,
        ...(options.connections === undefined ? {} : { connections: options.connections }),
        ...(options.connectionCatalog === undefined ? {} : { catalog: options.connectionCatalog }),
        ...(probeFor === undefined ? {} : { probeFor }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    revision: () => app.state().revision,
  }
}

function createLazyProductionConnectionAdapter(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
): ProductionConnectionAdapter {
  let loaded: Promise<ProductionConnectionAdapter> | undefined
  const adapter = (): Promise<ProductionConnectionAdapter> => {
    loaded ??= import('../../adapters/connections/production-connections.js').then(
      ({ createProductionConnectionAdapter }) => createProductionConnectionAdapter(record, options),
    )
    return loaded
  }
  return Object.freeze({
    record,
    capabilities: async () => (await adapter()).capabilities(),
    health: async (healthOptions?: ConnectionHealthOptions) =>
      (await adapter()).health(healthOptions),
    verifyModel: async (
      model: string,
      verificationOptions?: ConnectionModelVerificationOptions,
    ) => {
      const verify = (await adapter()).verifyModel
      if (verify === undefined)
        throw new Error('Production connection model verification is unavailable')
      return verify(model, verificationOptions)
    },
  })
}

export async function dispatchProfileConnectionIntent(
  intent: BraidIntent,
  services: ProfileConnectionDispatchServices,
): Promise<UiDispatchResult | undefined> {
  if (intent.type === 'run-command') {
    if (intent.command === 'profile')
      return dispatchProfileCommand(intent, services.profiles, services.revision)
    if (intent.command === 'connection')
      return dispatchConnectionCommand(intent, services.connections, services.revision)
    return undefined
  }
  if (intent.type !== 'headless-command') return undefined
  switch (intent.command) {
    case 'list_profiles':
      return accepted(
        await services.profiles.list(stringParam(intent.command, intent.params, 'query')),
        services.revision(),
      )
    case 'validate_profile':
      return accepted(
        await services.profiles.validate(requiredString(intent.command, intent.params, 'ref')),
        services.revision(),
      )
    case 'select_profile':
      return accepted(
        await services.profiles.select({
          operationId: requiredOperationId(intent),
          ref: requiredString(intent.command, intent.params, 'ref'),
          ...revisionParam(intent.command, intent.params),
        }),
        services.revision(),
        intent.operationId,
      )
    case 'save_profile':
      return accepted(
        await services.profiles.save({
          operationId: requiredOperationId(intent),
          ref: requiredString(intent.command, intent.params, 'ref'),
          profile: intent.params.profile,
          ...revisionParam(intent.command, intent.params),
        }),
        services.revision(),
        intent.operationId,
      )
    case 'list_connections':
      return accepted(
        await services.connections.list(stringParam(intent.command, intent.params, 'query')),
        services.revision(),
      )
    case 'upsert_connection':
      return accepted(
        await services.connections.upsert({
          operationId: requiredOperationId(intent),
          record: requiredConnectionRecord(intent.command, intent.params),
          ...revisionParam(intent.command, intent.params),
        }),
        services.revision(),
        intent.operationId,
      )
    case 'test_connection':
      return accepted(
        await services.connections.test({
          operationId: requiredOperationId(intent),
          connectionId: requiredString(intent.command, intent.params, 'connectionId'),
        }),
        services.revision(),
        intent.operationId,
      )
    case 'select_connection':
      return accepted(
        await services.connections.select({
          operationId: requiredOperationId(intent),
          connectionId: requiredString(intent.command, intent.params, 'connectionId'),
          ...revisionParam(intent.command, intent.params),
        }),
        services.revision(),
        intent.operationId,
      )
    case 'remove_connection':
      return accepted(
        await services.connections.remove({
          operationId: requiredOperationId(intent),
          connectionId: requiredString(intent.command, intent.params, 'connectionId'),
          ...revisionParam(intent.command, intent.params),
        }),
        services.revision(),
        intent.operationId,
      )
    default:
      return undefined
  }
}

async function dispatchProfileCommand(
  intent: Extract<BraidIntent, { readonly type: 'run-command' }>,
  service: ProfileActionService,
  revision: () => number,
): Promise<UiDispatchResult> {
  const [verb, ref] = intent.args
  if (verb === undefined || verb === 'list')
    return accepted(await service.list(ref ?? ''), revision())
  if (verb === 'validate') {
    if (ref === undefined) throw new AppError('INVALID_PARAMS', '/profile validate requires a ref')
    return accepted(await service.validate(ref), revision())
  }
  if (verb === 'save') {
    if (ref === undefined) throw new AppError('INVALID_PARAMS', '/profile save requires a ref')
    if (intent.operationId === undefined)
      throw new AppError('OPERATION_ID_REQUIRED', '/profile save requires operationId')
    return accepted(
      await service.saveCurrent({ operationId: intent.operationId, ref }),
      revision(),
      intent.operationId,
    )
  }
  if (intent.operationId === undefined)
    throw new AppError('OPERATION_ID_REQUIRED', '/profile select requires operationId')
  return accepted(
    await service.select({ operationId: intent.operationId, ref: verb }),
    revision(),
    intent.operationId,
  )
}

async function dispatchConnectionCommand(
  intent: Extract<BraidIntent, { readonly type: 'run-command' }>,
  service: ConnectionActions,
  revision: () => number,
): Promise<UiDispatchResult> {
  const [verb, ref] = intent.args
  if (verb === undefined || verb === 'list')
    return accepted(await service.list(ref ?? ''), revision())
  if (verb === 'test') {
    if (ref === undefined) throw new AppError('INVALID_PARAMS', '/connection test requires an id')
    if (intent.operationId === undefined)
      throw new AppError('OPERATION_ID_REQUIRED', '/connection test requires operationId')
    return accepted(
      await service.test({ operationId: intent.operationId, connectionId: ref }),
      revision(),
      intent.operationId,
    )
  }
  if (verb === 'remove') {
    if (ref === undefined) throw new AppError('INVALID_PARAMS', '/connection remove requires an id')
    if (intent.operationId === undefined)
      throw new AppError('OPERATION_ID_REQUIRED', '/connection remove requires operationId')
    return accepted(
      await service.remove({ operationId: intent.operationId, connectionId: ref }),
      revision(),
      intent.operationId,
    )
  }
  if (verb === 'select') {
    if (ref === undefined) throw new AppError('INVALID_PARAMS', '/connection select requires an id')
    if (intent.operationId === undefined)
      throw new AppError('OPERATION_ID_REQUIRED', '/connection select requires operationId')
    return accepted(
      await service.select({ operationId: intent.operationId, connectionId: ref }),
      revision(),
      intent.operationId,
    )
  }
  if (intent.operationId === undefined)
    throw new AppError('OPERATION_ID_REQUIRED', '/connection select requires operationId')
  return accepted(
    await service.select({ operationId: intent.operationId, connectionId: ref ?? verb }),
    revision(),
    intent.operationId,
  )
}

function accepted(data: unknown, revision: number, operationId?: string): UiDispatchResult {
  return {
    kind: 'accepted',
    revision,
    ...(operationId === undefined ? {} : { operationId }),
    ...(data !== undefined ? { data } : {}),
    ...operationFields(data),
  }
}

function operationFields(data: unknown): { readonly replayed?: boolean } {
  if (data === null || typeof data !== 'object') return {}
  const value = data as { readonly replayed?: unknown }
  return 'replayed' in value && typeof value.replayed === 'boolean'
    ? { replayed: value.replayed }
    : {}
}

function requiredOperationId(
  intent: Extract<BraidIntent, { readonly type: 'headless-command' }>,
): string {
  if (intent.operationId === undefined)
    throw new AppError('OPERATION_ID_REQUIRED', `${intent.command} requires operationId`)
  return intent.operationId
}

function requiredString(
  command: string,
  params: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0)
    throw new AppError('INVALID_PARAMS', `${command}.params.${name} must be a non-empty string`)
  return value
}

function stringParam(
  command: string,
  params: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = params[name]
  if (value === undefined) return ''
  if (typeof value !== 'string')
    throw new AppError('INVALID_PARAMS', `${command}.params.${name} must be a string`)
  return value
}

function requiredConnectionRecord(
  command: string,
  params: Readonly<Record<string, unknown>>,
): ConnectionRecord {
  const value = params.record
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_PARAMS', `${command}.params.record must be a connection record`)
  }
  return value as ConnectionRecord
}

function revisionParam(
  command: string,
  params: Readonly<Record<string, unknown>>,
): { readonly expectedRevision?: number } {
  const value = params.expectedRevision
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new AppError(
      'INVALID_EXPECTED_REVISION',
      `${command}.params.expectedRevision must be a non-negative integer`,
    )
  return { expectedRevision: value }
}
