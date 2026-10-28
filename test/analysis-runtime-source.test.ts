import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type {
  AnalystFinding,
  ExactAnalystRunEvent,
  ExactAnalystRunResult,
} from '@tangle-network/agent-eval'
import type { ToolSpan } from '@tangle-network/agent-eval/traces'
import { canonicalAgentProfileDigest, defineAgentProfile } from '@tangle-network/agent-interface'
import { loadTopSnapshot } from '@tangle-network/agent-runtime/tui'
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
import type { SupervisorRecord, WorkerRecord } from '../src/domain/entities.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

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
async function recordRuntimeRun(
  runDir: string,
  runId: string,
  observation?: { readonly ready: () => void; readonly release: Promise<void> },
): Promise<void> {
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
    signal: AbortSignal.timeout(45_000),
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
        observation?.ready()
        await observation?.release
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
              yield {
                kind: 'cost',
                usd: 0.125,
                usdKnown: false,
                usdEstimated: 0.125,
                provenance: 'catalog-estimate',
              }
            })(),
          traceSource: () => ({ onSpan: () => () => {}, collect: async () => [span] }),
          teardown: async () => ({ destroyed: true }),
          resultArtifact: () => ({
            outRef: 'record:worker',
            out: { worker: 'worker' },
            verdict: { valid: true, score: 1 },
            spent: {
              iterations: 1,
              tokens: { input: 5, output: 5 },
              usd: 0.125,
              usdKnown: false,
              usdEstimated: 0.125,
              ms: 0,
            },
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
  // Ending an RPC session closes Braid, so each step reopens the durable app: a restart per step.
  let initialized = false
  async function step(command: Record<string, unknown>) {
    const durable = await createDurableBraidApplication(options)
    try {
      if (!initialized) {
        durable.app.initialize(root)
        await durable.app.whenDurable()
        initialized = true
      }
      return { responses: await rpc(durable.app, [command]), runs: durable.app.state().runs.length }
    } finally {
      await durable.storage.close()
    }
  }
  try {
    const opened = await step(analyze(`runtime:${runId}@${runDir}`, 'op-1'))
    const first = result(opened.responses)
    assert.equal(first.status, 'completed')
    assert.deepEqual(first.source.runtimeRun, { runId, runDir })
    assert.equal(first.source.runId, undefined)
    assert.equal(first.source.complete, true)
    assert.equal(opened.runs, 0)
    const [finding] = first.analysis.findings
    assert.equal(finding?.supported, true)
    assert.deepEqual(finding?.citations[0]?.span, { traceId: `${runId}:s0`, spanId: 'edit-1' })
    assert.equal(analyst.requests.length, 1)
    const details = await step({
      command: 'get_details',
      params: { entityType: 'analysis', entityId: first.analysis.id },
    })
    const detail = details.responses.find((row) => row.type === 'ack')
    assert(detail?.type === 'ack')
    assert.deepEqual(
      (detail.result as { data: { findings: { citations: { span?: unknown }[] }[] } }).data
        .findings[0]?.citations[0]?.span,
      { traceId: `${runId}:s0`, spanId: 'edit-1' },
    )

    const promoted = await step({
      command: 'promote_analysis',
      operationId: 'op-promote',
      params: { analysisId: first.analysis.id, findingIds: ['finding-runtime'] },
    })
    assert(
      promoted.responses.some((item) => item.type === 'ack'),
      JSON.stringify(promoted.responses),
    )

    const wrongRun = await step(analyze(`runtime:run:other@${runDir}`, 'op-2'))
    assert(wrongRun.responses.some((item) => item.type === 'error'))
    assert.match(JSON.stringify(wrongRun.responses), /not recorded in/u)
    assert.equal(analyst.requests.length, 1)

    const replay = result((await step(analyze(`runtime:${runId}@${runDir}`, 'op-1'))).responses)
    assert.equal(replay.analysis.id, first.analysis.id)
    assert.equal(replay.source.digest, first.source.digest)
    assert.equal(analyst.requests.length, 1)

    for (const name of await readdir(join(runDir, 'blobs'))) await rm(join(runDir, 'blobs', name))
    const lost = await step(analyze(`runtime:${runId}@${runDir}`, 'op-3'))
    assert.match(JSON.stringify(lost.responses), /trace blob .* is missing/u)
    assert.equal(analyst.requests.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function runBytes(runDir: string) {
  const entries = await readdir(runDir, { recursive: true, withFileTypes: true })
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name)
        return {
          path,
          mode: (await stat(path)).mode,
          bytes: (await readFile(path)).toString('base64'),
        }
      }),
  )
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

test('built JSONL selects a Runtime-written durable run without granting control or mutating it', {
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-durable-jsonl-'))
  const runDir = join(root, 'run')
  const runId = 'run:durable-jsonl'
  let session: { forceStop(): Promise<unknown> } | undefined
  let release = () => {}
  const held = new Promise<void>((resolveRelease) => {
    release = resolveRelease
  })
  let ready = () => {}
  const started = new Promise<void>((resolveReady) => {
    ready = resolveReady
  })
  const recording = recordRuntimeRun(runDir, runId, { ready: () => ready(), release: held })
  try {
    await Promise.race([
      started,
      recording.then(() => {
        throw new Error('Runtime settled before live inspection')
      }),
    ])
    const expected = await loadTopSnapshot(runDir, { runDir })
    assert(expected.supervisors.length > 0)
    const keyFile = join(root, 'database.key')
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 })
    const { RpcSession } = await import(
      pathToFileURL(resolve('scripts/live-core/rpc-session.mjs')).href
    )
    const rpc = new RpcSession(
      resolve('dist/bin/braid.js'),
      runDir,
      keyFile,
      'http://127.0.0.1:1',
      15_000,
      ['--fixture', 'deterministic'],
    )
    session = rpc
    await rpc.request('initialize', { workspace: runDir })
    const { response } = await rpc.request('refresh_supervision', { runDir })
    const view = response.result as {
      supervisors: SupervisorRecord[]
      workers: WorkerRecord[]
      graphEdges: unknown[]
    }
    assert.deepEqual(
      view.supervisors.map((row) => row.runtimeId),
      expected.supervisors.map((row) => row.id),
    )
    assert(
      view.supervisors.some((row) => row.status === 'running'),
      'the held Runtime root must be observed live',
    )
    assert(view.workers.length > 0)
    assert(view.graphEdges.length > 0)
    assert(view.supervisors.every((row) => row.runDir === runDir && row.rootRunId === undefined))
    assert(!view.supervisors.some((row) => String(row.id) === row.runtimeId))
    release()
    await recording
    const before = await runBytes(runDir)
    const settled = await rpc.request('refresh_supervision', { runDir })
    assert(
      (settled.response.result.supervisors as SupervisorRecord[]).every(
        (row) => row.status !== 'running',
      ),
    )
    const supervisor = view.supervisors[0]!
    const worker = view.workers[0]!
    const settledSnapshot = await loadTopSnapshot(runDir, { runDir })
    const canonicalWorker = settledSnapshot.supervisors[0]?.workers.find(
      (row) => row.id === worker.runtimeId,
    )
    assert.equal(canonicalWorker?.spend.usdKnown, false)
    const settledWorker = (settled.response.result.workers as WorkerRecord[]).find(
      (row) => row.id === worker.id,
    )
    assert.equal(settledWorker?.spendUsd, undefined)
    assert.equal(settledWorker?.estimatedSpendUsd, 0.125)
    assert.equal(
      (settled.response.result.supervisors as SupervisorRecord[])[0]?.totalUsage?.spendUsd,
      undefined,
    )
    await assert.rejects(
      rpc.request(
        'steer_worker',
        { supervisorId: supervisor.id, workerId: worker.id, text: 'must not reach Runtime' },
        'op-readonly-worker',
      ),
      /not present/u,
    )
    await assert.rejects(
      rpc.request('cancel_supervisor', { supervisorId: supervisor.id }, 'op-readonly-root'),
      /not present/u,
    )
    const graph = await rpc.request('get_graph', {})
    assert(JSON.stringify(graph.response.result).includes(String(worker.id)))
    const workerNode = (graph.response.result.nodes as { id: string; costUsd?: number }[]).find(
      (row) => row.id === worker.id,
    )
    assert(workerNode)
    assert.equal(
      workerNode.costUsd,
      undefined,
      'estimated dollars must not become an observed graph cost',
    )
    const details = await rpc.request('get_details', { entityType: 'worker', entityId: worker.id })
    assert(JSON.stringify(details.response.result).includes(worker.runtimeId))
    assert.equal(details.response.result.data.spendUsd, undefined)
    assert.equal(details.response.result.data.estimatedSpendUsd, 0.125)
    const state = await rpc.state()
    assert.equal(state.state.runs.length, 0, 'Runtime identifiers must not manufacture Braid runs')
    await assert.rejects(
      rpc.request('refresh_supervision', { runDir, remoteEndpointEnv: 'TEST_REMOTE' }),
      /cannot be combined/u,
    )
    await assert.rejects(
      rpc.request('refresh_supervision', { runDir, extra: true }),
      /unknown field extra/u,
    )
    await assert.rejects(rpc.request('get_state', { projection: 3 }), /must be string/u)
    await assert.rejects(rpc.request('send', { text: 'must not run' }), /requires operationId/u)
    await assert.rejects(
      rpc.request('shutdown', { mode: 'invalid' }, 'op-invalid-shutdown'),
      /must be wait, detach, or cancel/u,
    )
    await rpc.shutdown()
    assert.equal((await rpc.exit).code, 0)
    assert(!rpc.stdout.includes(CREDENTIAL))
    assert.deepEqual(await runBytes(runDir), before)
  } finally {
    release()
    await recording.catch(() => {})
    await session?.forceStop()
    await rm(root, { recursive: true, force: true })
  }
})

test('production JSONL retains native System One unavailability and exact selected analysis bounds without a model call', {
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-systemone-jsonl-'))
  const runDir = join(root, 'runtime')
  const workspace = join(root, 'workspace')
  const runId = 'run:systemone-source'
  const bridge = await startRuntimeBridgeServer({
    advertisedModels: [{ id: 'pi/openai/gpt-5', backend: 'pi' }],
  })
  let session: { forceStop(): Promise<unknown> } | undefined
  try {
    await mkdir(workspace)
    await recordRuntimeRun(runDir, runId)
    const before = await runBytes(runDir)
    const selected = defineAgentProfile({
      name: 'Native analysis proof',
      harness: 'pi',
      model: { provider: 'openai', default: 'openai/gpt-5' },
    })
    const keyFile = join(root, 'database.key')
    const config = join(root, 'config.json')
    const at = new Date().toISOString()
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 })
    await writeFile(
      config,
      JSON.stringify({
        format: 'braid-startup-config',
        schemaVersion: 2,
        profile: selected,
        connectionId: 'connection-native-analysis',
        connections: [
          {
            id: 'connection-native-analysis',
            name: 'Native analysis',
            kind: 'cli-bridge',
            endpoint: bridge.endpoint,
            providerOptions: { transport: 'local' },
            createdAt: at,
            updatedAt: at,
            lastHealth: { status: 'unknown' },
          },
        ],
      }),
      { mode: 0o600 },
    )
    const { RpcSession } = await import(
      pathToFileURL(resolve('scripts/live-core/rpc-session.mjs')).href
    )
    const rpc = new RpcSession(
      resolve('dist/bin/braid.js'),
      workspace,
      keyFile,
      bridge.endpoint,
      60_000,
      ['--config', config],
    )
    session = rpc
    await rpc.request('initialize', { workspace })
    const { response } = await rpc.request(
      'analyze',
      {
        source: `runtime:${runId}@${runDir}`,
        recipe: 'systemone',
        budgetUsd: 1,
        totalTimeoutMs: 30_000,
      },
      'op-systemone-native',
    )
    const result = response.result
    assert.equal(result.status, 'failed')
    assert.match(
      result.error,
      /native retained-result contract does not report served model identity/u,
    )
    assert.equal(result.analysis.request.budgetUsd, 1)
    assert.equal(result.analysis.request.totalTimeoutMs, 30_000)
    assert.deepEqual(result.source.runtimeRun, { runId, runDir })
    assert.equal(result.source.runId, undefined)
    assert.equal(
      result.analysis.provenance.profileDigest,
      canonicalAgentProfileDigest(selected).replace(/^sha256:/u, ''),
    )
    assert.equal(result.analysis.provenance.connectionId, 'connection-native-analysis')
    assert(
      result.analysis.analysts.some(
        (row: { analystId: string; status: string; detail?: string }) =>
          row.analystId === 'systemone' &&
          row.status === 'failed' &&
          row.detail?.includes('served model identity'),
      ),
    )
    assert.deepEqual(result.analysis.modelCalls, [])
    assert.equal(result.analysis.costUsd, undefined)
    assert.equal(bridge.requests.length, 0)
    assert.equal(bridge.sessions.length, 0)
    await rpc.shutdown()
    assert.equal((await rpc.exit).code, 0)
    assert.deepEqual(await runBytes(runDir), before)
  } finally {
    await session?.forceStop()
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})
