import { type AgentProfile, defineAgentProfile } from '@tangle-network/agent-interface'
import { AgentRuntimeExecutionPort } from '../adapters/runtime/agent-runtime-execution.js'
import { type Clock, FixedClock, SystemClock } from '../ports/clock.js'
import { type IdSource, RandomIds, SequenceIds } from '../ports/ids.js'
import { deterministicBackend, unconfiguredBackend } from '../testing/deterministic-backend.js'
import { BraidApplication } from './application.js'
import {
  EncryptedAnalysisRepository,
  EncryptedBraidStatePort,
  AnalysisService,
  type BraidStateKeyPort,
  type AnalysisRepository,
  type AnalysisState,
  InMemoryAnalysisRepository,
} from '../analysis/service.js'
import { createW11FixtureAnalystRegistry } from '../analysis/analysts.js'
import { InMemoryAnalysisSourcePort } from '../analysis/source-port.js'
import type { AnalysisSourcePort } from '../analysis/source.js'
import { applicationAnalysisBinding } from './analysis-source.js'
import type { RuntimeSupervisorPort } from '../supervisor/runtime-supervisor.js'

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
  readonly analysis?: AnalysisService
  readonly analysisSourceId?: () => string
  readonly analysisSource?: AnalysisSourcePort
  readonly analysisRepository?: AnalysisRepository
  readonly analysisStatePath?: string
  readonly analysisKey?: BraidStateKeyPort
  readonly supervisor?: RuntimeSupervisorPort
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
  let application!: BraidApplication
  const source =
    options.analysisSource ??
    new InMemoryAnalysisSourcePort([
      applicationAnalysisBinding(
        () => application.state(),
        () => application.events(),
        () => application.analysisTraces(),
        () => application.analysisRunId(),
      ),
    ])
  const repository =
    options.analysisRepository ??
    (options.analysisStatePath && options.analysisKey
      ? new EncryptedAnalysisRepository(
          new EncryptedBraidStatePort<AnalysisState>(
            options.analysisStatePath,
            options.analysisKey,
          ),
        )
      : isFixture
        ? new InMemoryAnalysisRepository()
        : undefined)
  const analysis =
    options.analysis ??
    (isFixture && repository
      ? new AnalysisService({ source, repository, registry: createW11FixtureAnalystRegistry() })
      : undefined)
  application = new BraidApplication({
    profile: options.profile ?? (isFixture ? DETERMINISTIC_PROFILE : STARTER_PROFILE),
    execution,
    clock: options.clock ?? (isFixture ? new FixedClock() : new SystemClock()),
    ids: options.ids ?? (isFixture ? new SequenceIds() : new RandomIds()),
    analysisSource: source,
    ...(analysis ? { analysis } : {}),
    ...(options.analysisSourceId ? { analysisSourceId: options.analysisSourceId } : {}),
    ...(options.supervisor ? { supervisor: options.supervisor } : {}),
  })
  return application
}
