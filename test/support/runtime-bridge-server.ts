import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type AgentProfile, canonicalAgentProfileDigest } from '@tangle-network/agent-interface'

const PROFILE_MATERIALIZATION_SCHEMA = 'cli-bridge.profile-materialization.v2'
const USAGE_COST_SCHEMA = 'cli-bridge.usage-cost.v1'

export interface RuntimeBridgeRequest {
  readonly authorization?: string
  readonly body: Readonly<Record<string, unknown>>
  readonly rawBody: string
  readonly runId: string
  readonly sessionId?: string
}

export interface RuntimeBridgeServerOptions {
  readonly advertisedModels?: ReadonlyArray<{
    readonly id: string
    readonly backend: string
  }>
  readonly expectedBearer?: string
  readonly responseText?: string | ((body: Readonly<Record<string, unknown>>) => string)
  readonly estimatedCostUsd?: number
  readonly usage?: {
    readonly promptTokens: number
    readonly completionTokens: number
    readonly cacheReadInputTokens?: number
    readonly cacheCreationInputTokens?: number
    readonly reasoningTokens?: number
  }
  readonly holdStreams?: boolean
  readonly statusFailureStatus?: number
  readonly statusRunId?: string
  readonly cancellation?: {
    readonly mode?: 'acknowledged' | 'rejected'
    readonly delayMs?: number
    readonly effect?: 'cancel_requested' | 'cancelled'
  }
}

export interface RuntimeBridgeCancellationRequest {
  readonly runId: string
  readonly waitMs: number
}

export interface RuntimeBridgeReplayRequest {
  readonly runId: string
  readonly afterSequence: number
}

export interface RuntimeBridgeServer {
  readonly endpoint: string
  readonly requests: RuntimeBridgeRequest[]
  readonly cancellations: RuntimeBridgeCancellationRequest[]
  readonly replays: RuntimeBridgeReplayRequest[]
  complete(runId?: string): void
  close(): Promise<void>
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function expectedAppliedReasoning(
  harness: string,
  requested: AgentProfile['model'] extends { readonly reasoningEffort?: infer T }
    ? T | null
    : string | null,
): string | null {
  if (requested === null || requested === undefined) return null
  switch (harness) {
    case 'pi':
      return requested === 'none' ? 'off' : requested === 'ultracode' ? 'xhigh' : requested
    case 'claude-code':
      return requested === 'none' || requested === 'minimal'
        ? 'low'
        : requested === 'ultracode'
          ? 'max'
          : requested
    case 'codex':
      return requested === 'none'
        ? 'minimal'
        : requested === 'xhigh' || requested === 'ultracode'
          ? 'high'
          : requested
    case 'kimi-code':
      if (requested === 'medium') return null
      return requested === 'none' || requested === 'minimal' || requested === 'low'
        ? '--no-thinking'
        : '--thinking'
    case 'gemini':
      return null
    default:
      return requested
  }
}

function profileMaterialization(body: Readonly<Record<string, unknown>>) {
  const profile = body.agent_profile as AgentProfile
  const harness = profile.harness
  const model = body.model
  if (typeof harness !== 'string' || typeof model !== 'string') {
    throw new TypeError('Runtime Bridge fixture requires an exact profile and model')
  }
  const requested = profile.model?.reasoningEffort ?? null
  const files = (profile.resources?.files ?? []).map((file) => ({
    path: file.path,
    mode: 0o600,
  }))
  return {
    schema: PROFILE_MATERIALIZATION_SCHEMA,
    effectiveProfileDigest: canonicalAgentProfileDigest(profile),
    harness,
    provider: profile.model?.provider ?? null,
    model,
    reasoningEffort: {
      requested,
      applied: expectedAppliedReasoning(harness, requested),
    },
    workspacePlanDigest: sha256(JSON.stringify({ cwd: body.cwd ?? null, files })),
    files,
    unsupported: [],
  }
}

interface RuntimeResponseFrame {
  readonly id: number
  readonly wire: string
}

function runtimeResponseFrames(
  body: Readonly<Record<string, unknown>>,
  responseText: string,
  estimatedCostUsd?: number,
  usage?: RuntimeBridgeServerOptions['usage'],
): readonly RuntimeResponseFrame[] {
  const terminal = {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: {
      model_requests: 1,
      prompt_tokens: usage?.promptTokens ?? 2,
      completion_tokens: usage?.completionTokens ?? 3,
      ...(usage?.cacheReadInputTokens === undefined
        ? {}
        : { cache_read_input_tokens: usage.cacheReadInputTokens }),
      ...(usage?.cacheCreationInputTokens === undefined
        ? {}
        : { cache_creation_input_tokens: usage.cacheCreationInputTokens }),
      ...(usage?.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens }),
      cost_known: false,
      ...(estimatedCostUsd === undefined
        ? {}
        : { estimated_cost: estimatedCostUsd, cost_provenance: 'catalog-estimate' }),
    },
    profile_materialization: profileMaterialization(body),
  }
  return [
    {
      id: 1,
      wire: `id: 1\ndata: ${JSON.stringify({ choices: [{ delta: { content: responseText }, finish_reason: null }] })}\n\n`,
    },
    { id: 2, wire: `id: 2\ndata: ${JSON.stringify(terminal)}\n\n` },
  ]
}

function runtimeResponseStream(frames: readonly RuntimeResponseFrame[]): string {
  return `${frames.map((frame) => frame.wire).join('')}data: [DONE]\n\n`
}

function runtimeResponseResult(
  body: Readonly<Record<string, unknown>>,
  text: string,
  estimatedCostUsd?: number,
  usage?: RuntimeBridgeServerOptions['usage'],
): Readonly<Record<string, unknown>> {
  const promptTokens = usage?.promptTokens ?? 2
  const completionTokens = usage?.completionTokens ?? 3
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: {
      model_requests: 1,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(usage?.cacheReadInputTokens === undefined
        ? {}
        : { cache_read_input_tokens: usage.cacheReadInputTokens }),
      ...(usage?.cacheCreationInputTokens === undefined
        ? {}
        : { cache_creation_input_tokens: usage.cacheCreationInputTokens }),
      ...(usage?.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens }),
      ...(estimatedCostUsd === undefined ? {} : { cost: estimatedCostUsd }),
    },
    profile_materialization: profileMaterialization(body),
  }
}

function responseText(
  configured: RuntimeBridgeServerOptions['responseText'],
  body: Readonly<Record<string, unknown>>,
): string {
  if (typeof configured === 'function') return configured(body)
  return configured ?? 'production response'
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

export async function startRuntimeBridgeServer(
  options: RuntimeBridgeServerOptions = {},
): Promise<RuntimeBridgeServer> {
  const requests: RuntimeBridgeRequest[] = []
  const cancellations: RuntimeBridgeCancellationRequest[] = []
  const replays: RuntimeBridgeReplayRequest[] = []
  interface RetainedFixtureRun {
    readonly id: string
    readonly digest: string
    readonly body: Readonly<Record<string, unknown>>
    readonly frames: RuntimeResponseFrame[]
    readonly pendingFrames: RuntimeResponseFrame[]
    readonly readers: Set<ServerResponse>
    status: 'running' | 'done' | 'cancelled'
    terminal: boolean
  }
  const runs = new Map<string, RetainedFixtureRun>()

  const runHeaders = (run: RetainedFixtureRun) => ({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-run-id': run.id,
    'x-run-request-digest': run.digest,
  })

  const attachReader = (
    run: RetainedFixtureRun,
    response: ServerResponse,
    afterSequence = 0,
  ): void => {
    response.writeHead(200, runHeaders(run))
    for (const frame of run.frames) {
      if (frame.id > afterSequence) response.write(frame.wire)
    }
    if (run.terminal) {
      response.end('data: [DONE]\n\n')
      return
    }
    run.readers.add(response)
    response.once('close', () => run.readers.delete(response))
  }

  const finishReaders = (run: RetainedFixtureRun): void => {
    for (const reader of run.readers) reader.end('data: [DONE]\n\n')
    run.readers.clear()
  }

  const completeRun = (run: RetainedFixtureRun): void => {
    if (run.terminal) return
    const terminalFrames = run.pendingFrames.splice(0)
    run.frames.push(...terminalFrames)
    run.status = 'done'
    run.terminal = true
    for (const reader of run.readers) {
      for (const frame of terminalFrames) reader.write(frame.wire)
    }
    finishReaders(run)
  }

  const server = createServer(async (request, response) => {
    const authorization = request.headers.authorization
    if (
      options.expectedBearer !== undefined &&
      authorization !== `Bearer ${options.expectedBearer}`
    ) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'unauthorized' } }))
      return
    }

    const path = new URL(request.url ?? '/', 'http://runtime-bridge.test').pathname
    if (request.method === 'GET' && path === '/') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          capabilities: {
            profileMaterialization: PROFILE_MATERIALIZATION_SCHEMA,
            usageCostProvenance: USAGE_COST_SCHEMA,
          },
        }),
      )
      return
    }
    if (request.method === 'GET' && path === '/health') {
      const backends = (options.advertisedModels ?? []).map(({ backend }) => ({
        name: backend,
        state: 'ready',
      }))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', backends }))
      return
    }
    if (request.method === 'GET' && path === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: options.advertisedModels ?? [] }))
      return
    }
    const eventsMatch = /^\/v1\/runs\/([^/]+)\/events$/u.exec(path)
    if (request.method === 'GET' && eventsMatch !== null) {
      const runId = decodeURIComponent(eventsMatch[1] ?? '')
      const run = runs.get(runId)
      if (run === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'run_not_found' } }))
        return
      }
      const cursor = request.headers['last-event-id']
      const afterSequence = cursor === undefined ? 0 : Number(cursor)
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'invalid_event_cursor' } }))
        return
      }
      replays.push({ runId, afterSequence })
      attachReader(run, response, afterSequence)
      return
    }
    const statusMatch = /^\/v1\/runs\/([^/]+)$/u.exec(path)
    if (request.method === 'GET' && statusMatch !== null) {
      const runId = decodeURIComponent(statusMatch[1] ?? '')
      const run = runs.get(runId)
      if (run === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'run_not_found' } }))
        return
      }
      if (options.statusFailureStatus !== undefined) {
        response.writeHead(options.statusFailureStatus, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'status_unavailable' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: options.statusRunId ?? run.id,
          requestDigest: run.digest,
          status: run.status,
          terminal: run.terminal,
        }),
      )
      return
    }
    const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/u.exec(path)
    if (request.method === 'POST' && cancelMatch !== null) {
      const runId = decodeURIComponent(cancelMatch[1] ?? '')
      const waitMs = Number(
        new URL(request.url ?? '/', 'http://runtime-bridge.test').searchParams.get('wait_ms') ??
          '0',
      )
      cancellations.push({ runId, waitMs: Number.isFinite(waitMs) ? waitMs : 0 })
      const rawCancellation = await readBody(request)
      const exactCancellation = rawCancellation.length === 0 ? {} : JSON.parse(rawCancellation)
      const configuredDelay = options.cancellation?.delayMs ?? 0
      if (configuredDelay > 0) await new Promise((resolve) => setTimeout(resolve, configuredDelay))
      const run = runs.get(runId)
      const requestDigest = run?.digest ?? sha256('missing-run')
      if (options.cancellation?.mode === 'rejected') {
        response.writeHead(409, { 'content-type': 'application/json' })
        if (
          exactCancellation !== null &&
          typeof exactCancellation === 'object' &&
          'operationId' in exactCancellation &&
          'requestDigest' in exactCancellation &&
          'run' in exactCancellation
        ) {
          response.end(
            JSON.stringify({
              operationId: exactCancellation.operationId,
              requestDigest: exactCancellation.requestDigest,
              run: exactCancellation.run,
              status: 'unknown',
              effect: 'unknown',
              message: 'fixture cancellation rejected',
              retryable: false,
            }),
          )
        } else {
          response.end(JSON.stringify({ error: { type: 'cancel_rejected' } }))
        }
        return
      }
      const cancellationEffect =
        run === undefined ? 'not_live' : (options.cancellation?.effect ?? 'cancelled')
      if (run !== undefined && cancellationEffect === 'cancelled') {
        run.status = 'cancelled'
        run.terminal = true
        finishReaders(run)
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-run-id': runId,
        'x-run-request-digest': requestDigest,
      })
      if (
        exactCancellation !== null &&
        typeof exactCancellation === 'object' &&
        'operationId' in exactCancellation &&
        'requestDigest' in exactCancellation &&
        'run' in exactCancellation
      ) {
        response.end(
          JSON.stringify({
            operationId: exactCancellation.operationId,
            requestDigest: exactCancellation.requestDigest,
            run: exactCancellation.run,
            status: 'accepted',
            effect: cancellationEffect,
          }),
        )
      } else {
        response.end(
          JSON.stringify({
            cancelled: run !== undefined,
            cancel_requested: true,
            terminal: cancellationEffect !== 'cancel_requested',
            run: {
              id: runId,
              requestDigest,
              status: cancellationEffect === 'cancel_requested' ? 'running' : 'cancelled',
              terminal: cancellationEffect !== 'cancel_requested',
            },
          }),
        )
      }
      return
    }
    if (request.method !== 'POST' || path !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }

    const rawBody = await readBody(request)
    const body = JSON.parse(rawBody) as Record<string, unknown>
    const requestedRunId = body.run_id ?? request.headers['x-run-id']
    if (typeof requestedRunId !== 'string' || requestedRunId.length === 0) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'missing_run_id' } }))
      return
    }
    const runId = requestedRunId
    const existing = runs.get(runId)
    const digest = existing?.digest ?? sha256(rawBody)
    requests.push({
      ...(authorization === undefined ? {} : { authorization }),
      body,
      rawBody,
      runId,
      ...(typeof request.headers['x-session-id'] === 'string'
        ? { sessionId: request.headers['x-session-id'] }
        : {}),
    })
    const text = responseText(options.responseText, body)
    if (body.stream === false) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-run-id': runId,
        'x-run-request-digest': digest,
      })
      response.end(
        JSON.stringify(runtimeResponseResult(body, text, options.estimatedCostUsd, options.usage)),
      )
      return
    }
    const frames = runtimeResponseFrames(body, text, options.estimatedCostUsd, options.usage)
    const run =
      existing ??
      ({
        id: runId,
        digest,
        body,
        frames: options.holdStreams ? frames.slice(0, 1) : [...frames],
        pendingFrames: options.holdStreams ? frames.slice(1) : [],
        readers: new Set<ServerResponse>(),
        status: options.holdStreams ? 'running' : 'done',
        terminal: !options.holdStreams,
      } satisfies RetainedFixtureRun)
    runs.set(runId, run)
    if (options.holdStreams) attachReader(run, response)
    else {
      response.writeHead(200, runHeaders(run))
      response.end(runtimeResponseStream(run.frames))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    cancellations,
    replays,
    complete: (runId) => {
      if (runId !== undefined) {
        const run = runs.get(runId)
        if (run !== undefined) completeRun(run)
        return
      }
      for (const run of runs.values()) completeRun(run)
    },
    close: async () => {
      for (const run of runs.values()) finishReaders(run)
      await closeServer(server)
    },
  }
}
