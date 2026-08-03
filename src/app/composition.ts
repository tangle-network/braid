import { defineAgentProfile, type AgentProfile } from '@tangle-network/agent-interface'
import type { CredentialPort } from '../ports/credentials.js'
import { createOperatingSystemCredentialStore } from '../adapters/credentials/os.js'
import type { HeadlessKeySource } from '../adapters/credentials/headless-key.js'
import { openSqliteStorage, type SqliteStorage } from '../adapters/storage/sqlite.js'
import { AgentRuntimeExecutionPort } from '../adapters/runtime/agent-runtime-execution.js'
import { FixedClock, SystemClock, type Clock } from '../ports/clock.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import { RandomIds, SequenceIds, type IdSource } from '../ports/ids.js'
import type { EffectStoragePort, JournalPort } from '../ports/effect-storage.js'
import { deterministicBackend, unconfiguredBackend } from '../testing/deterministic-backend.js'
import { BraidApplication } from './application.js'
import { createMemoryJournal } from './journal.js'
import { FailClosedJournal } from './fail-closed-journal.js'
import { StorageJournal } from './storage-journal.js'
import { workspaceIdForRoot } from './storage-journal.js'
import { createBranchId, createConversationId } from '../domain/ids.js'

export const STARTER_PROFILE: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Braid starter',
  description: 'A portable starter profile for the Braid terminal',
})

export const DETERMINISTIC_PROFILE: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Braid starter',
  description: 'A portable starter profile for the Braid terminal',
  harness: 'pi',
  model: {
    default: 'fixture/deterministic',
    reasoningEffort: 'none',
  },
})

export interface CompositionOptions {
  readonly fixture?: 'deterministic'
  readonly clock?: Clock
  readonly ids?: IdSource
  readonly profile?: Readonly<AgentProfile>
  readonly chunkDelayMs?: number
  readonly journal?: JournalPort
  readonly effectStorage?: EffectStoragePort
  readonly effectCoordinator?: SerializedEffectCoordinator
}

export interface DurableCompositionOptions
  extends Omit<CompositionOptions, 'fixture' | 'journal' | 'effectStorage'> {
  readonly path: string
  readonly workspaceRoot?: string
  readonly credentialStore?: CredentialPort
  readonly databaseKeyRef?: import('../ports/credentials.js').CredentialRef
  readonly databaseKeySource?: HeadlessKeySource
  readonly backupDirectory?: string
}

export interface DurableBraidApplication {
  readonly app: BraidApplication
  readonly storage: SqliteStorage
}

function isEffectStorage(value: JournalPort): value is JournalPort & EffectStoragePort {
  return (
    typeof (value as Partial<EffectStoragePort>).reserveEffect === 'function' &&
    typeof (value as Partial<EffectStoragePort>).current === 'function' &&
    typeof (value as Partial<EffectStoragePort>).latest === 'function' &&
    typeof (value as Partial<EffectStoragePort>).appendEffect === 'function' &&
    typeof (value as Partial<EffectStoragePort>).history === 'function'
  )
}

export function createBraidApplication(options: CompositionOptions = {}): BraidApplication {
  const isFixture = options.fixture === 'deterministic'
  const execution = new AgentRuntimeExecutionPort((input) =>
    isFixture
      ? deterministicBackend(input, {
          ...(options.chunkDelayMs === undefined ? {} : { chunkDelayMs: options.chunkDelayMs }),
        })
      : unconfiguredBackend(input),
  )
  const clock = options.clock ?? (isFixture ? new FixedClock() : new SystemClock())
  const journal =
    options.journal ?? (isFixture ? createMemoryJournal(clock) : new FailClosedJournal(clock))
  const effectStorage =
    options.effectStorage ?? (isEffectStorage(journal) ? journal : new FailClosedJournal(clock))
  return new BraidApplication({
    profile: options.profile ?? (isFixture ? DETERMINISTIC_PROFILE : STARTER_PROFILE),
    execution,
    clock,
    ids: options.ids ?? (isFixture ? new SequenceIds() : new RandomIds()),
    journal,
    effectStorage,
    ...(options.effectCoordinator === undefined
      ? {}
      : { effectCoordinator: options.effectCoordinator }),
  })
}

export async function createDurableBraidApplication(
  options: DurableCompositionOptions,
): Promise<DurableBraidApplication> {
  const clock = options.clock ?? new SystemClock()
  const credentialStore = options.credentialStore ?? createOperatingSystemCredentialStore()
  const storage = await openSqliteStorage({
    path: options.path,
    credentialStore,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    ...(options.databaseKeyRef === undefined ? {} : { databaseKeyRef: options.databaseKeyRef }),
    ...(options.databaseKeySource === undefined
      ? {}
      : { databaseKeySource: options.databaseKeySource }),
    ...(options.backupDirectory === undefined ? {} : { backupDirectory: options.backupDirectory }),
  })
  const workspaceId =
    options.workspaceRoot === undefined ? undefined : workspaceIdForRoot(options.workspaceRoot)
  const identity =
    workspaceId === undefined
      ? {}
      : {
          conversationId: createConversationId(
            `conversation-${workspaceId.slice('workspace-'.length)}`,
          ),
          branchId: createBranchId(`branch-${workspaceId.slice('workspace-'.length)}`),
        }
  try {
    const scopedJournal = await StorageJournal.fromStorage(
      storage,
      clock,
      workspaceId === undefined ? {} : { workspaceId },
    )
    const app = new BraidApplication({
      profile: options.profile ?? STARTER_PROFILE,
      execution: new AgentRuntimeExecutionPort((input) => unconfiguredBackend(input)),
      clock,
      ids: options.ids ?? new RandomIds(),
      journal: scopedJournal,
      effectStorage: storage,
      ...identity,
      ...(options.effectCoordinator === undefined
        ? {}
        : { effectCoordinator: options.effectCoordinator }),
    })
    return { app, storage }
  } catch (error) {
    await storage.close().catch(() => undefined)
    throw error
  }
}
