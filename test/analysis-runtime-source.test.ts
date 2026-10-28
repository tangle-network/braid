import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  AnalystFinding,
  ExactAnalystRunEvent,
  ExactAnalystRunResult,
} from '@tangle-network/agent-eval'
import type { ToolSpan } from '@tangle-network/agent-eval/traces'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { supervisePursuit } from '@tangle-network/agent-runtime/durable'
import type { EvalAnalystRequest } from '../src/adapters/analysis/eval-analyst.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import type { AnalysisAnalyst } from '../src/app/analysis-execution-session.js'
import type { BraidApplication } from '../src/app/application.js'
import {
  createDeterministicExecution,
  createDurableBraidApplication,
  DETERMINISTIC_PROFILE,
} from '../src/app/composition.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'

const MARKER = 'RUNTIME-SPAN-MARKER wrote primes.txt'
const CREDENTIAL = 'sk-ant-api03-runtimesourcecanary0123456789abcdefghijklmnop'
const COORDINATION = 'agent_runtime_coordination_'

function profile(name: string, tools: readonly string[] = []) {
  return defineAgentProfile({
    name,
    harness: 'opencode',
    model: { provider: 'offline', default: 'offline-test-model' },
    ...(tools.length === 0
      ? {}
      : { tools: Object.fromEntries(tools.map((tool) => [`${COORDINATION}${tool}`, true])) }),
  })
}

async function coordinate(url: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const body = (await response.json()) as { error?: unknown; result?: { isError?: boolean } }
  if (!response.ok || body.error !== undefined || body.result?.isError === true) {
    throw new Error(`coordination ${name} failed: ${JSON.stringify(body)}`)
  }
}

/** A settled Runtime run whose one worker recorded a tool span, written by Runtime itself. */
async function recordRuntimeRun(runDir: string, runId: string): Promise<void> {
  const span: ToolSpan = {
    spanId: 'edit-1',
    runId: 'worker',
    kind: 'tool',
    name: 'edit',
    toolName: 'edit',
    args: { path: 'primes.txt', token: CREDENTIAL },
    result: MARKER,
    startedAt: 1,
    endedAt: 2,
    status: 'ok',
  }
  let drives = 0
  await supervisePursuit(profile('root', ['spawn_worker', 'stop']), 'delegate once', {
    pursuitId: 'pursuit:braid-analysis',
    runId,
    runDir,
    budget: { maxIterations: 100, maxTokens: 100_000 },
    perWorker: { maxIterations: 4, maxTokens: 1_000 },
    driveHarness: async ({ coordinationMcpUrl }) => {
      drives += 1
      if (drives === 1) {
        await coordinate(coordinationMcpUrl, 'spawn_worker', {
          profile: profile('worker'),
          task: 'deliver',
          label: 'worker',
        })
      } else {
        await coordinate(coordinationMcpUrl, 'stop', {})
      }
    },
    makeWorkerAgent: () => ({
      name: 'worker',
      act: async () => ({ worker: 'worker' }),
      executorSpec: {
        profile: profile('worker'),
        harness: null,
        executor: {
          runtime: 'braid-analysis-test',
          execute: () =>
            (async function* () {
              yield { kind: 'iteration' }
              yield { kind: 'tokens', input: 5, output: 5 }
            })(),
          traceSource: () => ({ onSpan: () => () => {}, collect: async () => [span] }),
          teardown: async () => ({ destroyed: true }),
          resultArtifact: () => ({
            outRef: 'record:worker',
            out: { worker: 'worker' },
            verdict: { valid: true, score: 1 },
            spent: { iterations: 1, tokens: { input: 5, output: 5 }, usd: 0, ms: 0 },
          }),
        },
      },
    }),
  } as Parameters<typeof supervisePursuit>[2])
}

/** Finds the recorded span through the frozen trace store and cites it, as a real analyst would. */
class CitingAnalyst implements AnalysisAnalyst {
  readonly requests: EvalAnalystRequest[] = []
  list() {
    return [
      {
        id: 'runtime-citer',
        description: 'Cites the first Runtime span it finds',
        version: 'test',
        cost: { kind: 'deterministic' as const },
      },
    ]
  }
  resolveAnalystIds() {
    return ['runtime-citer']
  }
  async *stream(request: EvalAnalystRequest) {
    this.requests.push(request)
    const page = await request.trace.store.queryTraces({ limit: 10 })
    const traceId = page.traces[0]?.trace_id ?? ''
    const view = await request.trace.store.viewTrace({ trace_id: traceId })
    const text = JSON.stringify(view)
    assert(!text.includes(CREDENTIAL), 'the analyst saw an unredacted credential')
    const spanId = /"span_id":"([^"]+)"/u.exec(text)?.[1] ?? ''
    const finding: AnalystFinding = {
      schema_version: '1.0.0',
      finding_id: 'finding-runtime',
      analyst_id: 'runtime-citer',
      produced_at: '2026-10-27T00:00:00Z',
      severity: 'low',
      area: 'tool-use',
      claim: 'The worker edited primes.txt.',
      confidence: 0.9,
      evidence_refs: [
        { kind: 'span', uri: `trace://${traceId}/span/${spanId}`, excerpt: 'RUNTIME-SPAN-MARKER' },
      ],
    } as AnalystFinding
    const result = {
      run_id: request.runId,
      correlation_id: 'runtime-source',
      started_at: '2026-10-27T00:00:00Z',
      ended_at: '2026-10-27T00:00:01Z',
      findings: [finding],
      per_analyst: [],
      total_cost_usd: 0,
      execution_plan: {},
      completion: { status: 'complete' },
    } as unknown as ExactAnalystRunResult
    yield { event: { type: 'run-completed', result } as unknown as ExactAnalystRunEvent, result }
  }
}

async function rpc(
  app: BraidApplication,
  commands: readonly Record<string, unknown>[],
): Promise<BraidResponse[]> {
  const responses: BraidResponse[] = []
  const lines = [
    { command: 'initialize', params: { workspace: app.state().workspace } },
    ...commands,
  ].map((command, index) => JSON.stringify({ version: 1, requestId: `req-${index}`, ...command }))
  await runRpc(
    createApplicationUiController(app),
    (async function* () {
      for (const line of lines) yield `${line}\n`
    })(),
    {
      write(chunk) {
        for (const line of chunk.trim().split('\n'))
          responses.push(JSON.parse(line) as BraidResponse)
        return true
      },
    },
  )
  return responses.filter(
    (response) => !('requestId' in response) || response.requestId !== 'req-0',
  )
}

function result(responses: readonly BraidResponse[]) {
  const response = responses.find((item) => item.type === 'ack' || item.type === 'error')
  assert(response?.type === 'ack', JSON.stringify(response))
  return response.result as {
    status: string
    analysis: {
      id: string
      findings: { supported: boolean; citations: { span?: unknown; quote?: string }[] }[]
    }
    source: { digest: string; runId?: string; runtimeRun?: unknown; complete: boolean }
  }
}

test('a Runtime durable run is analyzed, cited and replayed without a Braid run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-runtime-source-'))
  const runDir = join(root, 'runtime-run')
  const runId = 'run:braid-analysis'
  await recordRuntimeRun(runDir, runId)
  const analyst = new CitingAnalyst()
  const options = {
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    profile: DETERMINISTIC_PROFILE,
    execution: createDeterministicExecution({ chunkDelayMs: 0 }),
    intelligence: { analyst },
  }
  const analyze = (source: string, operationId: string) => ({
    command: 'analyze',
    operationId,
    params: { source, recipe: 'failure' },
  })
  let durable = await createDurableBraidApplication(options)
  try {
    durable.app.initialize(root)
    await durable.app.whenDurable()

    const first = result(await rpc(durable.app, [analyze(`runtime:${runId}@${runDir}`, 'op-1')]))
    assert.equal(first.status, 'completed')
    assert.deepEqual(first.source.runtimeRun, { runId, runDir })
    assert.equal(first.source.runId, undefined)
    assert.equal(first.source.complete, true)
    assert.equal(durable.app.state().runs.length, 0)
    const [finding] = first.analysis.findings
    assert.equal(finding?.supported, true)
    assert.deepEqual(finding?.citations[0]?.span, { traceId: 'worker', spanId: 'edit-1' })
    assert.equal(analyst.requests.length, 1)

    const wrongRun = await rpc(durable.app, [analyze(`runtime:run:other@${runDir}`, 'op-2')])
    assert(wrongRun.some((item) => item.type === 'error' || item.type === 'ack'))
    assert.match(JSON.stringify(wrongRun), /not recorded in/u)
    assert.equal(analyst.requests.length, 1)

    await durable.storage.close()
    durable = await createDurableBraidApplication(options)
    const replay = result(await rpc(durable.app, [analyze(`runtime:${runId}@${runDir}`, 'op-1')]))
    assert.equal(replay.analysis.id, first.analysis.id)
    assert.equal(replay.source.digest, first.source.digest)
    assert.equal(analyst.requests.length, 1)

    for (const name of await readdir(join(runDir, 'blobs'))) await rm(join(runDir, 'blobs', name))
    const lost = await rpc(durable.app, [analyze(`runtime:${runId}@${runDir}`, 'op-3')])
    assert.match(JSON.stringify(lost), /trace blob .* is missing/u)
    assert.equal(analyst.requests.length, 1)
  } finally {
    await durable.storage.close()
    await rm(root, { recursive: true, force: true })
  }
})
