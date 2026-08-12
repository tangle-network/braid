import type { AnalysisComparisonResult } from '../../app/analysis-comparison-contracts.js'
import type { AnalysisRecord } from '../../domain/entities.js'
import {
  createAnalysisId,
  createBranchId,
  createCitationId,
  createConversationId,
  createDigest,
  createEventId,
  createProfileId,
  createRunId,
} from '../../domain/ids.js'
import type { ForkPreviewView, InteractionView } from '../../views/shared/models.js'

export type UiFixture = 'interaction' | 'fork' | 'analysis' | 'comparison' | 'product-demo'

export const FIXTURE_INTERACTION: InteractionView = Object.freeze({
  runId: 'fixture-run-1',
  interactionId: 'fixture-interaction-1',
  profileName: 'Braid starter',
  runner: 'pi',
  kind: 'permission',
  prompt: 'Allow the fixture tool to inspect the selected file?',
  subject: Object.freeze({
    type: 'file',
    title: 'src/app/application.ts',
    target: 'read-only',
    detail: 'The fixture requests a bounded read for a real interaction preview.',
    preview: Object.freeze(['export class BraidApplication {', '  cancel(input: CancelInput) { …']),
    trustedWorkspace: 'inside',
  }),
  answerSpec: Object.freeze({ kind: 'boolean', required: true }),
  allowedOutcomes: Object.freeze(['accept', 'reject', 'cancel'] as const),
  responseScopes: Object.freeze(['once', 'session'] as const),
  queuePosition: 0,
  queueTotal: 1,
  secret: false,
})

export const FIXTURE_FORK: ForkPreviewView = Object.freeze({
  kind: 'workspace',
  source: 'workspace:/workspace',
  destination: 'workspace:/workspace-fork',
  fields: Object.freeze([
    {
      label: 'conversation context',
      source: 'conv-1 / branch-1',
      destination: 'conv-fork-1 / branch-1',
    },
    {
      label: 'profile snapshot',
      source: 'digest:fixture-source',
      destination: 'digest:fixture-copy',
    },
    {
      label: 'workspace state',
      source: 'checkpoint:fixture-1',
      destination: 'checkpoint:fixture-1',
    },
    {
      label: 'operation id',
      source: 'operation-fixture-fork',
      destination: 'operation-fixture-fork',
    },
    {
      label: 'plan digest',
      source: 'digest:fixture-fork-plan',
      destination: 'digest:fixture-fork-plan',
    },
  ]),
  allowed: true,
})

const FIXTURE_ANALYSIS_RECORD: AnalysisRecord = Object.freeze({
  id: createAnalysisId('analysis-fixture-1'),
  question: 'Where did this run waste time, and what should change?',
  recipe: 'ask',
  analystProfileId: createProfileId('profile-trace-reviewer'),
  status: 'completed',
  source: Object.freeze({
    conversationId: createConversationId('conversation-fixture-analysis'),
    branchId: createBranchId('branch-fixture-analysis'),
    runId: createRunId('run-cli-bridge-reconnect'),
    digest: createDigest('da8ae2345b2c17abf658ad4b126ae4480fe92be54e94e701b6ea9ff67c9190eb'),
    complete: true,
  }),
  findings: Object.freeze([
    Object.freeze({
      id: 'finding-route-order',
      text: 'Profile inspection and route resolution ran serially although their inputs were independent.',
      severity: 'medium' as const,
      confidence: 0.94,
      supported: true,
      citations: Object.freeze([
        Object.freeze({
          id: createCitationId('citation-profile-route-order'),
          eventId: createEventId('event-runtime-route-start'),
          quote: 'profile.inspect completed before runtime.route started',
        }),
      ]),
    }),
    Object.freeze({
      id: 'finding-package-proof',
      text: 'The answer claimed success before the packaged terminal check completed.',
      severity: 'high' as const,
      confidence: 0.88,
      supported: true,
      citations: Object.freeze([
        Object.freeze({
          id: createCitationId('citation-package-proof'),
          eventId: createEventId('event-package-check-start'),
          quote: 'package check started; no terminal result was recorded',
        }),
      ]),
    }),
  ]),
  costUsd: 0.0048,
  wallTimeMs: 1_240,
  createdAt: '2026-08-04T04:00:00.000Z',
  updatedAt: '2026-08-04T04:00:01.240Z',
})

export const FIXTURE_ANALYSIS_DATA = Object.freeze({
  status: 'completed' as const,
  analysis: FIXTURE_ANALYSIS_RECORD,
  source: Object.freeze({
    digest: FIXTURE_ANALYSIS_RECORD.source.digest,
    conversationId: FIXTURE_ANALYSIS_RECORD.source.conversationId,
    branchId: FIXTURE_ANALYSIS_RECORD.source.branchId,
    runId: FIXTURE_ANALYSIS_RECORD.source.runId,
    complete: true,
    eventCount: 14,
    messageCount: 4,
    messagePartCount: 9,
  }),
})

const PRODUCT_DEMO_ANALYSIS_RECORD: AnalysisRecord = Object.freeze({
  ...FIXTURE_ANALYSIS_RECORD,
  id: createAnalysisId('analysis-product-route'),
  question: 'What should this agent improve next?',
  source: Object.freeze({
    conversationId: createConversationId('conv-1'),
    branchId: createBranchId('branch-1'),
    runId: createRunId('run-000001'),
    digest: createDigest('a9ed803bccc91483b9f55e20ad2123fb1a2a73ad088b2847e5b600e726b84d74'),
    complete: true,
  }),
  findings: Object.freeze([
    Object.freeze({
      id: 'finding-route-receipt',
      text: 'The route was explicit, but the final answer did not cite its materialization receipt.',
      severity: 'medium' as const,
      confidence: 0.93,
      supported: true,
      citations: Object.freeze([
        Object.freeze({
          id: createCitationId('citation-route-receipt'),
          eventId: createEventId('event-runtime-route'),
          quote: 'runtime.route completed: Local CLI Bridge → Pi',
        }),
      ]),
    }),
    Object.freeze({
      id: 'finding-serial-route',
      text: 'Profile inspection and route resolution ran serially even though their inputs were independent.',
      severity: 'low' as const,
      confidence: 0.86,
      supported: true,
      citations: Object.freeze([
        Object.freeze({
          id: createCitationId('citation-serial-route'),
          eventId: createEventId('event-profile-before-route'),
          quote: 'profile.inspect completed before runtime.route started',
        }),
      ]),
    }),
  ]),
})

export const PRODUCT_DEMO_ANALYSIS_DATA = Object.freeze({
  status: 'completed' as const,
  analysis: PRODUCT_DEMO_ANALYSIS_RECORD,
  source: Object.freeze({
    digest: PRODUCT_DEMO_ANALYSIS_RECORD.source.digest,
    conversationId: PRODUCT_DEMO_ANALYSIS_RECORD.source.conversationId,
    branchId: PRODUCT_DEMO_ANALYSIS_RECORD.source.branchId,
    runId: PRODUCT_DEMO_ANALYSIS_RECORD.source.runId,
    complete: true,
    eventCount: 14,
    messageCount: 2,
    messagePartCount: 4,
  }),
})

export const FIXTURE_COMPARISON_RESULT: AnalysisComparisonResult = Object.freeze({
  baselineSourceDigest: '9ee7d219c8b00928de97a5ceccddc718ba478955ccd7824df834a8458c519924',
  candidateSourceDigest: '0328e6889082b14ba363c0d9e6a924a5cf44edea3cd67f54745b50aa86b0ff3d',
  baselineRunId: 'run-route-serial',
  candidateRunId: 'run-route-parallel',
  fields: Object.freeze([
    Object.freeze({
      name: 'run.status',
      baseline: 'completed',
      candidate: 'completed',
      baselinePresent: true,
      candidatePresent: true,
      asymmetry: 'none' as const,
    }),
    Object.freeze({
      name: 'run.cost_usd',
      baseline: 0.014,
      candidate: 0.009,
      baselinePresent: true,
      candidatePresent: true,
      asymmetry: 'none' as const,
    }),
    Object.freeze({
      name: 'run.wall_time_ms',
      baseline: 18_200,
      candidate: 12_100,
      baselinePresent: true,
      candidatePresent: true,
      asymmetry: 'none' as const,
    }),
    Object.freeze({
      name: 'run.input_tokens',
      baseline: 7_420,
      candidate: 6_910,
      baselinePresent: true,
      candidatePresent: true,
      asymmetry: 'none' as const,
    }),
  ]),
  rows: Object.freeze([
    Object.freeze({
      pairKey: 'fixture-pair-1',
      arm: 'baseline',
      pass: true,
      metrics: Object.freeze({ cost_usd: 0.014, latency_ms: 18_200 }),
    }),
    Object.freeze({
      pairKey: 'fixture-pair-1',
      arm: 'candidate',
      pass: true,
      metrics: Object.freeze({ cost_usd: 0.009, latency_ms: 12_100 }),
    }),
  ]),
  paired: Object.freeze({
    nPairs: 1,
    nUnpairedBaseline: 0,
    nUnpairedTreatment: 0,
    correctness: Object.freeze({
      b10: 0,
      b01: 0,
      mcnemar: Object.freeze({ n: 1, nDiscordant: 0, b: 0, c: 0, statistic: 0, pValue: 1 }),
      riskDifference: Object.freeze({
        n: 1,
        b: 0,
        c: 0,
        riskDifference: 0,
        lower: 0,
        upper: 0,
        confidence: 0.95,
      }),
    }),
    metricDeltas: [
      Object.freeze({
        name: 'cost_usd',
        n: 1,
        nMissing: 0,
        medianDelta: -0.005,
        meanDelta: -0.005,
        bootstrapCi: Object.freeze({
          n: 1,
          median: -0.005,
          mean: -0.005,
          low: -0.005,
          high: -0.005,
          confidence: 0.95,
          resamples: 2_000,
          gateEligible: false,
        }),
        wilcoxon: Object.freeze({ w: 0, p: 1, method: 'exact' as const, pFloor: 1, nNonZero: 1 }),
      }),
      Object.freeze({
        name: 'latency_ms',
        n: 1,
        nMissing: 0,
        medianDelta: -6_100,
        meanDelta: -6_100,
        bootstrapCi: Object.freeze({
          n: 1,
          median: -6_100,
          mean: -6_100,
          low: -6_100,
          high: -6_100,
          confidence: 0.95,
          resamples: 2_000,
          gateEligible: false,
        }),
        wilcoxon: Object.freeze({ w: 0, p: 1, method: 'exact' as const, pFloor: 1, nNonZero: 1 }),
      }),
    ],
  }),
  semantic: Object.freeze({
    status: 'unavailable' as const,
    reason: 'One saved pair is descriptive; semantic review was not requested.',
  }),
  replayed: true,
})
