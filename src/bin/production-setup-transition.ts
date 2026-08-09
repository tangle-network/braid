import type { BraidApplication } from '../app/application.js'
import type { ConnectionRegistry } from '../app/connections.js'
import type { ConfigurationSelection } from '../app/configuration-session.js'
import { prepareProductionSelection } from './production-setup-credentials.js'
import {
  type ProductionStartupPersistence,
  persistProductionStartupSelection,
} from './production-setup-persistence.js'
import type {
  ProductionSetupVerification,
  ProductionStartupSetup,
} from './production-setup-types.js'
import { validateProductionSelection } from './production-setup-validation.js'
import type { ProductionStartupLoadOptions } from './production-startup.js'

export interface ProductionApplicationHandle {
  readonly app: BraidApplication
  readonly connections?: ConnectionRegistry
  readonly close: () => Promise<void>
}

export interface ProductionApplicationSlot {
  current: ProductionApplicationHandle
}

export interface ProductionSetupController {
  /**
   * Replaces the active app atomically: a rejected promise must leave the old
   * app installed and must not publish a partially installed replacement.
   */
  replaceApplication(next: BraidApplication, workspace: string): Promise<void>
}

export interface ProductionSetupTransitionOptions {
  readonly setup: ProductionStartupSetup
  readonly startupOptions: ProductionStartupLoadOptions
  readonly selection: ConfigurationSelection
  readonly workspace: string
  /** Session-only credential captured by the terminal; the caller retains ownership. */
  readonly credential?: Uint8Array
  readonly controller: ProductionSetupController
  readonly active: ProductionApplicationSlot
  /** Opens and durably initializes from the in-memory selection. */
  readonly openApplication: (
    selection: ConfigurationSelection,
    options: ProductionStartupLoadOptions,
  ) => Promise<ProductionApplicationHandle>
  readonly activate?: (
    next: ProductionApplicationHandle,
    selection: ConfigurationSelection,
    startupOptions: ProductionStartupLoadOptions,
  ) => Promise<void>
  readonly validate?: typeof validateProductionSelection
  readonly persist?: (
    configPath: string,
    selection: ConfigurationSelection,
    options?: {
      readonly databaseKeyFile?: string
      readonly connections?: readonly import('../domain/entities.js').ConnectionRecord[]
    },
  ) => Promise<ProductionStartupPersistence>
}

async function closeAfterFailure(
  next: ProductionApplicationHandle,
  failure: unknown,
  rollbackCredential: () => Promise<void>,
): Promise<never> {
  await next.close().catch(() => undefined)
  try {
    await rollbackCredential()
  } catch (rollbackError) {
    throw new Error(
      'The secure connection credential could not be rolled back after setup failed',
      {
        cause: rollbackError,
      },
    )
  }
  throw failure
}

async function failBeforeOpen(
  rollbackCredential: () => Promise<void>,
  failure: unknown,
): Promise<never> {
  try {
    await rollbackCredential()
  } catch (rollbackError) {
    throw new Error(
      'The secure connection credential could not be rolled back after setup failed',
      {
        cause: rollbackError,
      },
    )
  }
  throw failure
}

/** Validates, prepares, persists, swaps, and finally closes the previous application. */
export async function transitionProductionSelection(
  options: ProductionSetupTransitionOptions,
): Promise<ProductionSetupVerification> {
  const prepared = await prepareProductionSelection(
    options.startupOptions,
    options.selection,
    options.setup.configPath,
    options.credential,
  )
  let verification: ProductionSetupVerification
  let next: ProductionApplicationHandle
  try {
    verification = await (options.validate ?? validateProductionSelection)(
      prepared.startupOptions,
      prepared.selection,
    )
    next = await options.openApplication(prepared.selection, prepared.startupOptions)
  } catch (error) {
    return failBeforeOpen(prepared.rollback, error)
  }
  let persistence: ProductionStartupPersistence
  try {
    persistence = await (options.persist ?? persistProductionStartupSelection)(
      options.setup.configPath,
      prepared.selection,
      {
        ...(prepared.startupOptions.databaseKeyFile === undefined
          ? {}
          : { databaseKeyFile: prepared.startupOptions.databaseKeyFile }),
        connections: options.setup.connections,
      },
    )
  } catch (error) {
    return closeAfterFailure(next, error, prepared.rollback)
  }
  try {
    await options.activate?.(next, prepared.selection, prepared.startupOptions)
  } catch (error) {
    try {
      await persistence.rollback()
    } catch (rollbackError) {
      return closeAfterFailure(
        next,
        new Error('The production configuration could not be rolled back after activation failed', {
          cause: rollbackError,
        }),
        prepared.rollback,
      )
    }
    return closeAfterFailure(next, error, prepared.rollback)
  }
  try {
    await options.controller.replaceApplication(next.app, options.workspace)
  } catch (error) {
    try {
      await persistence.rollback()
    } catch (rollbackError) {
      return closeAfterFailure(
        next,
        new Error('The production configuration could not be rolled back after activation failed', {
          cause: rollbackError,
        }),
        prepared.rollback,
      )
    }
    return closeAfterFailure(next, error, prepared.rollback)
  }
  const previous = options.active.current
  options.active.current = next
  await previous.close().catch(() => undefined)
  await prepared.commit()
  return verification
}
