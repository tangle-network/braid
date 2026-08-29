import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type AgentEnvironmentCapabilities,
  type AgentProfile,
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'

const PROFILE_MATERIALIZATION_SCHEMA = 'cli-bridge.profile-materialization.v2'
const USAGE_COST_SCHEMA = 'cli-bridge.usage-cost.v1'

/** One native retained session the Bridge created for a Pi route. */
export interface RuntimeBridgeSession {
  readonly id: string
  readonly model: string
  readonly createRequestDigest: string
  readonly body: Readonly<Record<string, unknown>>
}

export interface RuntimeBridgeRequest {
  readonly authorization?: string
  readonly body: Readonly<Record<string, unknown>>
  readonly rawBody: string
  readonly runId: string
  readonly sessionId?: string
  /** Present when the turn ran inside a native retained session instead of one chat request. */
  readonly session?: RuntimeBridgeSession
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
  readonly sessions: RuntimeBridgeSession[]
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
  const profile = body.agent_profile as AgentProfile | undefined
  const harness = profile?.harness
  const model = body.model
  if (profile === undefined || typeof harness !== 'string' || typeof model !== 'string') {
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

/**
 * Capability document the Bridge publishes for its native Pi route.
 *
 * Mirrors `PI_NATIVE_CAPABILITIES` in cli-bridge `src/backends/pi-native-start.ts`.
 * The cli-bridge provider intersects this document with its own adapter document,
 * so native continuation and permission interactions exist only on this route.
 */
const PI_NATIVE_CAPABILITIES: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: false,
    systemPrompt: { replace: true, append: true },
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: {
      files: false,
      instructions: true,
      tools: false,
      skills: true,
      agents: true,
      commands: true,
    },
    hooks: false,
    modes: true,
    runtimeUpdate: false,
    validation: true,
    extensions: ['pi'],
  },
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  retainedControl: {
    exactRunIdentity: true,
    resultIdentity: true,
    eventIdentity: true,
    cancellationIdempotency: true,
  },
  nativeContinuation: {
    atomicBoundary: true,
    requestIdempotency: true,
    admissionControl: true,
  },
  sessions: { continue: true, list: true, messages: true },
  interactions: {
    kinds: ['permission'],
    answerFieldTypes: ['select'],
    responseScopes: ['interaction'],
    secretAnswers: false,
    concurrentRequests: false,
    replay: true,
    responseIdempotency: true,
  },
  workspace: { read: true, write: true, exec: true, git: true, upload: false, download: false },
  branching: { checkpoint: false, fork: false },
  placement: true,
  usage: true,
  confidential: false,
}

/**
 * Capability document the Bridge publishes for a ready non-native route.
 *
 * Mirrors `genericCliBridgeCapabilities` in cli-bridge `src/sessions/retained/capabilities.ts`:
 * durable one-shot runs with exact identity, replay, detach, and cancellation, and no native
 * continuation or native interactions.
 */
const GENERIC_CAPABILITIES: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: false,
    systemPrompt: { replace: true, append: true },
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: {
      files: true,
      instructions: true,
      tools: true,
      skills: true,
      agents: true,
      commands: true,
    },
    hooks: false,
    modes: true,
    runtimeUpdate: false,
    validation: true,
  },
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, list: false, messages: false },
  retainedControl: {
    exactRunIdentity: true,
    resultIdentity: true,
    eventIdentity: true,
    cancellationIdempotency: true,
  },
  workspace: {
    read: false,
    write: false,
    exec: false,
    git: false,
    upload: false,
    download: false,
  },
  branching: { checkpoint: false, fork: false },
  placement: true,
  usage: true,
  confidential: false,
  observation: {
    identity: true,
    lifecycle: true,
    endpoint: true,
    placement: true,
    resources: false,
    resourceUse: false,
    modelUsage: true,
    computeBilling: false,
    accountUsage: false,
  },
}

/** The document the Bridge would publish for one model route, for stubbed fetches. */
export function bridgeCapabilityDocument(model: string): AgentEnvironmentCapabilities {
  return bridgeBackendForModel(model) === 'pi' ? PI_NATIVE_CAPABILITIES : GENERIC_CAPABILITIES
}

function bridgeBackendForModel(model: string): string {
  return model.split('/', 1)[0] ?? model
}

/** Select the Bridge route document exactly as the server resolves a backend by model. */
function capabilityDocument(
  model: string,
  advertisedModels: RuntimeBridgeServerOptions['advertisedModels'],
): AgentEnvironmentCapabilities | undefined {
  const backend = bridgeBackendForModel(model)
  if (advertisedModels !== undefined) {
    const advertised = advertisedModels.some(
      (entry) => entry.id === model || entry.backend === backend,
    )
    if (!advertised) return undefined
  }
  return backend === 'pi' ? PI_NATIVE_CAPABILITIES : GENERIC_CAPABILITIES
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
  const sessions: RuntimeBridgeSession[] = []
  const cancellations: RuntimeBridgeCancellationRequest[] = []
  const replays: RuntimeBridgeReplayRequest[] = []
  interface RunCoordinates {
    readonly provider: string
    readonly environmentId: string
    readonly sessionId: string
    readonly executionId: string
  }
  interface RetainedFixtureRun extends RunCoordinates {
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
  const nativeSessions = new Map<string, RuntimeBridgeSession>()

  /** Exact run coordinates travel on every run response, as cli-bridge 0.9 requires. */
  const coordinateHeaders = (run: RetainedFixtureRun) => ({
    'x-run-id': run.id,
    'x-run-request-digest': run.digest,
    'x-run-provider': run.provider,
    'x-run-environment-id': run.environmentId,
    'x-run-session-id': run.sessionId,
    'x-run-execution-id': run.executionId,
  })

  const runHeaders = (run: RetainedFixtureRun) => ({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    ...coordinateHeaders(run),
  })

  const runView = (run: RetainedFixtureRun, id = run.id) => ({
    id,
    requestDigest: run.digest,
    provider: run.provider,
    environmentId: run.environmentId,
    sessionId: run.sessionId,
    executionId: run.executionId,
    status: run.status,
    terminal: run.terminal,
  })

  const sessionView = (session: RuntimeBridgeSession) => {
    const activeRun = Array.from(runs.values()).find(
      (run) => run.sessionId === session.id && !run.terminal,
    )
    return {
      id: session.id,
      object: 'session',
      create_request_digest: session.createRequestDigest,
      backend: bridgeBackendForModel(session.model),
      model: session.model,
      status: activeRun === undefined ? 'idle' : 'running',
      run_id: activeRun?.id ?? null,
      context_boundary: null,
    }
  }

  const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }

  const coordinatesFromBody = (
    body: Readonly<Record<string, unknown>>,
    sessionId: unknown,
  ): RunCoordinates | undefined => {
    const provider = body.provider
    const environmentId = body.environment_id
    const executionId = body.execution_id
    if (
      typeof provider !== 'string' ||
      typeof environmentId !== 'string' ||
      typeof sessionId !== 'string' ||
      typeof executionId !== 'string'
    ) {
      return undefined
    }
    return { provider, environmentId, sessionId, executionId }
  }

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

    const url = new URL(request.url ?? '/', 'http://runtime-bridge.test')
    const path = url.pathname
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
    if (request.method === 'GET' && path === '/v1/capabilities') {
      const model = url.searchParams.get('model')
      if (model === null || model.length === 0) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: { message: 'model query parameter is required', type: 'invalid_request_error' },
          }),
        )
        return
      }
      const document = capabilityDocument(model, options.advertisedModels)
      if (document === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: {
              message: `no backend matches model ${JSON.stringify(model)}`,
              type: 'not_found_error',
            },
          }),
        )
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(document))
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
      writeJson(response, 200, runView(run, options.statusRunId ?? run.id))
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
        ...(run === undefined
          ? { 'x-run-id': runId, 'x-run-request-digest': requestDigest }
          : coordinateHeaders(run)),
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
    if (request.method === 'POST' && path === '/v1/sessions') {
      const rawBody = await readBody(request)
      const body = JSON.parse(rawBody) as Record<string, unknown>
      const id = body.id
      const model = body.model
      if (typeof id !== 'string' || id.length === 0 || typeof model !== 'string') {
        writeJson(response, 400, {
          error: { message: 'session id and model are required', type: 'invalid_request_error' },
        })
        return
      }
      if (nativeSessions.has(id)) {
        writeJson(response, 409, {
          error: { message: `session ${JSON.stringify(id)} exists`, type: 'conflict_error' },
        })
        return
      }
      if (capabilityDocument(model, options.advertisedModels) === undefined) {
        writeJson(response, 404, {
          error: {
            message: `no backend matches model ${JSON.stringify(model)}`,
            type: 'not_found_error',
          },
        })
        return
      }
      const session: RuntimeBridgeSession = {
        id,
        model,
        createRequestDigest: canonicalCandidateDigest(body),
        body,
      }
      nativeSessions.set(id, session)
      sessions.push(session)
      writeJson(response, 201, sessionView(session))
      return
    }
    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/u.exec(path)
    if (request.method === 'GET' && sessionMatch !== null) {
      const session = nativeSessions.get(decodeURIComponent(sessionMatch[1] ?? ''))
      if (session === undefined) {
        writeJson(response, 404, { error: { type: 'not_found_error' } })
        return
      }
      writeJson(response, 200, sessionView(session))
      return
    }
    const turnMatch = /^\/v1\/sessions\/([^/]+)\/turns$/u.exec(path)
    if (request.method === 'POST' && turnMatch !== null) {
      const session = nativeSessions.get(decodeURIComponent(turnMatch[1] ?? ''))
      if (session === undefined) {
        writeJson(response, 404, { error: { type: 'not_found_error' } })
        return
      }
      const rawBody = await readBody(request)
      const body = JSON.parse(rawBody) as Record<string, unknown>
      const runId = body.run_id
      const coordinates = coordinatesFromBody(body, session.id)
      if (typeof runId !== 'string' || runId.length === 0 || coordinates === undefined) {
        writeJson(response, 400, { error: { type: 'missing_run_coordinates' } })
        return
      }
      const digest = sha256(rawBody)
      const existing = runs.get(runId)
      if (existing !== undefined && existing.digest !== digest) {
        writeJson(response, 409, { error: { type: 'run_exists' } })
        return
      }
      requests.push({
        ...(authorization === undefined ? {} : { authorization }),
        body,
        rawBody,
        runId,
        sessionId: session.id,
        session,
      })
      // The session binds the profile, model, and workspace for every native turn.
      const materialization = {
        agent_profile: session.body.agent_profile,
        model: session.model,
        ...(session.body.cwd === undefined ? {} : { cwd: session.body.cwd }),
      }
      const text = responseText(options.responseText, body)
      const frames = runtimeResponseFrames(
        materialization,
        text,
        options.estimatedCostUsd,
        options.usage,
      )
      const run =
        existing ??
        ({
          id: runId,
          digest,
          body,
          ...coordinates,
          frames: options.holdStreams ? frames.slice(0, 1) : [...frames],
          pendingFrames: options.holdStreams ? frames.slice(1) : [],
          readers: new Set<ServerResponse>(),
          status: options.holdStreams ? 'running' : 'done',
          terminal: !options.holdStreams,
        } satisfies RetainedFixtureRun)
      runs.set(runId, run)
      response.writeHead(202, { 'content-type': 'application/json', ...coordinateHeaders(run) })
      response.end(
        JSON.stringify({
          session: sessionView(session),
          run: runView(run),
          context_boundary: null,
        }),
      )
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
      writeJson(response, 400, { error: { type: 'missing_run_id' } })
      return
    }
    const coordinates = coordinatesFromBody(body, body.session_id)
    if (coordinates === undefined) {
      writeJson(response, 400, { error: { type: 'missing_run_coordinates' } })
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
    const frames = runtimeResponseFrames(body, text, options.estimatedCostUsd, options.usage)
    const run =
      existing ??
      ({
        id: runId,
        digest,
        body,
        ...coordinates,
        frames: options.holdStreams ? frames.slice(0, 1) : [...frames],
        pendingFrames: options.holdStreams ? frames.slice(1) : [],
        readers: new Set<ServerResponse>(),
        status: options.holdStreams ? 'running' : 'done',
        terminal: !options.holdStreams,
      } satisfies RetainedFixtureRun)
    if (body.stream === false) {
      runs.set(runId, run)
      response.writeHead(200, { 'content-type': 'application/json', ...coordinateHeaders(run) })
      response.end(
        JSON.stringify(runtimeResponseResult(body, text, options.estimatedCostUsd, options.usage)),
      )
      return
    }
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
    sessions,
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
