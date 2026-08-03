import { defineAgentProfile, type AgentProfile } from '@tangle-network/agent-interface'
import { AgentRuntimeExecutionPort } from '../adapters/runtime/agent-runtime-execution.js'
import { FixedClock, SystemClock, type Clock } from '../ports/clock.js'
import { RandomIds, SequenceIds, type IdSource } from '../ports/ids.js'
import { deterministicBackend, unconfiguredBackend } from '../testing/deterministic-backend.js'
import { BraidApplication } from './application.js'
import { FileJournal, type JournalPort } from './journal.js'

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
  readonly journalPath?: string
  readonly cancelTimeoutMs?: number
}

export function createBraidApplication(options: CompositionOptions = {}): BraidApplication {
  const isFixture = options.fixture === 'deterministic'
  const execution = new AgentRuntimeExecutionPort(
    (input) =>
      isFixture
        ? deterministicBackend(input, {
            ...(options.chunkDelayMs === undefined ? {} : { chunkDelayMs: options.chunkDelayMs }),
          })
        : unconfiguredBackend(input),
    isFixture ? async () => ({ status: 'cancelled' as const }) : undefined,
  )
  return new BraidApplication({
    profile: options.profile ?? (isFixture ? DETERMINISTIC_PROFILE : STARTER_PROFILE),
    execution,
    clock: options.clock ?? (isFixture ? new FixedClock() : new SystemClock()),
    ids: options.ids ?? (isFixture ? new SequenceIds() : new RandomIds()),
    ...(options.journal || options.journalPath
      ? {
          journal:
            options.journal ??
            new FileJournal(
              options.journalPath ?? '.braid/events.jsonl',
              options.clock ?? (isFixture ? new FixedClock() : new SystemClock()),
            ),
        }
      : {}),
    ...(options.cancelTimeoutMs === undefined ? {} : { cancelTimeoutMs: options.cancelTimeoutMs }),
  })
}
