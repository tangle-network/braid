import { readFile } from 'node:fs/promises'
import {
  createChatClient,
  createDspyRlmTraceEngine,
  OtlpFileTraceStore,
} from '@tangle-network/agent-eval'
import { createW11AnalystRegistry } from '../analysis/analysts.js'
import { assertFeedbackSafe } from '../analysis/feedback.js'
import {
  AnalysisService,
  EncryptedAnalysisRepository,
  EncryptedBraidStatePort,
  EnvironmentStateKeyPort,
  toJsonValue,
} from '../analysis/service.js'
import { validateSourceRecord, type AnalysisSourceRecord } from '../analysis/source.js'
import { InMemoryAnalysisSourcePort } from '../analysis/source.js'
import type { AnalysisState } from '../analysis/repository.js'
import { snapshotTraceStore } from '../analysis/trace-snapshot.js'
import { createLiveW11Judge } from './w11-runner.js'
import { createBraidApplication } from '../app/composition.js'
import type { ApplicationEvaluationInput } from '../app/evaluation-route.js'

export interface W11EvaluationCliOptions {
  readonly traceFile: string
  readonly sourceMetadata: string
  readonly repository: string
  readonly model: string
  readonly baseUrl: string
  readonly operationId: string
  readonly evaluationInputs: string
  readonly workspace?: string
}

async function liveCapture(
  options: Pick<W11EvaluationCliOptions, 'traceFile' | 'sourceMetadata'>,
): Promise<{
  readonly source: AnalysisSourceRecord
  readonly traceStore: Awaited<ReturnType<typeof snapshotTraceStore>>
}> {
  const metadataBytes = await readFile(options.sourceMetadata)
  const raw = JSON.parse(metadataBytes.toString('utf8')) as unknown
  assertFeedbackSafe(raw)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Source metadata must be an object')
  const source = raw as AnalysisSourceRecord
  validateSourceRecord(source)
  if (!source.runtime || !source.receiptId)
    throw new Error('Source metadata must provide exact runtime and receipt identities')
  const liveStore = new OtlpFileTraceStore({ path: options.traceFile })
  const traceStore = await snapshotTraceStore(liveStore, source.traceReferences)
  return { source, traceStore }
}

export async function runW11EvaluationCommand(options: W11EvaluationCliOptions): Promise<number> {
  const apiKey = process.env.BRAID_ANALYST_API_KEY
  if (!apiKey) throw new Error('BRAID_ANALYST_API_KEY is required; evaluation was not skipped')
  const rawInputs = JSON.parse(await readFile(options.evaluationInputs, 'utf8')) as unknown
  assertFeedbackSafe(rawInputs)
  if (!Array.isArray(rawInputs)) throw new Error('W11 evaluation inputs must be a JSON array')
  const evaluationInputs = rawInputs as ApplicationEvaluationInput[]
  const initial = await liveCapture(options)
  const sourcePort = new InMemoryAnalysisSourcePort([
    {
      source: initial.source,
      traceStore: initial.traceStore,
      currentRevision: async () => (await liveCapture(options)).source.sourceRevision,
      captureAtRevision: async () => liveCapture(options),
    },
  ])
  const engine = createDspyRlmTraceEngine({
    baseUrl: options.baseUrl,
    apiKey,
    model: options.model,
  })
  const statePort = new EncryptedBraidStatePort<AnalysisState>(
    options.repository,
    new EnvironmentStateKeyPort(),
  )
  const repository = new EncryptedAnalysisRepository(statePort)
  const service = new AnalysisService({
    source: sourcePort,
    repository,
    registry: createW11AnalystRegistry({ engine }),
  })
  const application = createBraidApplication({
    analysis: service,
    analysisSource: sourcePort,
    analysisSourceId: () => initial.source.sourceId,
  })
  application.initialize(options.workspace ?? process.cwd())
  const analysisResult = await application.executeAnalysisCommand(
    {
      command: 'analysis',
      kind: 'ask',
      question:
        process.env.BRAID_ANALYST_QUESTION ??
        'What does this run establish, and what remains uncertain?',
    },
    options.operationId,
  )
  if (!('status' in analysisResult))
    throw new Error('Application analysis returned no analysis record')
  const record = analysisResult
  if (record.status !== 'complete')
    throw new Error(`Analysis failed: ${record.error?.message ?? record.status}`)
  const chat = createChatClient({
    transport: 'router',
    baseUrl: options.baseUrl,
    apiKey,
    defaultModel: options.model,
  })
  const evaluation = await application.evaluateAnalysis(
    record,
    createLiveW11Judge(chat, options.model),
    evaluationInputs,
  )
  process.stdout.write(
    `${JSON.stringify(toJsonValue({ status: evaluation.evaluation.verdict.status, analysis: record, identity: evaluation.identity, evaluation: evaluation.evaluation }))}\n`,
  )
  return evaluation.evaluation.verdict.status === 'passed' ? 0 : 1
}
