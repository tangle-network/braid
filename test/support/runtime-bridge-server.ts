import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  AgentEnvironmentCapabilities,
  AgentExactRunControlRef,
  AgentProfile,
  InteractionRequest,
  InteractionRequestMaterial,
  InteractionResponseCommand,
  NativeContextBoundaryProof,
  NativeContextContinuationRequest,
} from '@tangle-network/agent-interface'
import {
  AgentExactRunControlRefSchema,
  AgentRunCancellationRequestSchema,
  InteractionResponseCommandSchema,
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
  harnessTypeSchema,
  interactionRequestDigest,
  NativeContextContinuationRequestSchema,
  NativeContextContinuationTurnSchema,
} from '@tangle-network/agent-interface'
import { defaultCliBridgeCapabilities } from '@tangle-network/agent-provider-cli-bridge'

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
  /** Capability document returned by discovery. Null makes discovery unavailable. */
  readonly advertisedCapabilities?: AgentEnvironmentCapabilities | null
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
  readonly interaction?: {
    readonly id?: string
    readonly title?: string
    readonly body?: string
  }
}

export interface RuntimeBridgeCancellationRequest {
  readonly runId: string
  readonly waitMs: number
  readonly body: Readonly<Record<string, unknown>>
}

export interface RuntimeBridgeReplayRequest {
  readonly runId: string
  readonly afterSequence: number
}

export interface RuntimeBridgeSessionCreateRequest {
  readonly sessionId: string
  readonly body: Readonly<Record<string, unknown>>
}

export interface RuntimeBridgeContinuationRequest {
  readonly sessionId: string
  readonly request: NativeContextContinuationRequest
  readonly turn: Readonly<Record<string, unknown>>
  readonly runId: string
}

export interface RuntimeBridgeInteractionResponseRequest {
  readonly runId: string
  readonly interactionId: string
  readonly command: InteractionResponseCommand
}

export interface RuntimeBridgeServer {
  readonly endpoint: string
  readonly requests: RuntimeBridgeRequest[]
  readonly sessionCreates: RuntimeBridgeSessionCreateRequest[]
  readonly continuations: RuntimeBridgeContinuationRequest[]
  readonly cancellations: RuntimeBridgeCancellationRequest[]
  readonly interactionResponses: RuntimeBridgeInteractionResponseRequest[]
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

function canonicalInteractionFrames(
  controlRef: AgentExactRunControlRef,
  options: NonNullable<RuntimeBridgeServerOptions['interaction']>,
): { readonly frames: readonly RuntimeResponseFrame[]; readonly request: InteractionRequest } {
  const interactionId = options.id ?? 'interaction-fixture-permission'
  const material: InteractionRequestMaterial = {
    id: interactionId,
    kind: 'permission',
    title: options.title ?? 'Allow this workspace change?',
    ...(options.body === undefined ? {} : { body: options.body }),
    subject: { type: 'command', command: 'apply_patch' },
    answerSpec: {
      fields: [
        {
          type: 'select',
          name: 'grant',
          label: 'Permission',
          required: true,
          options: [
            { value: 'allow_once', label: 'Allow once' },
            { value: 'deny', label: 'Deny' },
          ],
        },
      ],
    },
    responseScopes: ['interaction'],
    allowedOutcomes: ['accepted', 'declined', 'cancelled'],
    onTimeout: 'wait',
    binding: {
      runId: controlRef.runId,
      provider: controlRef.provider,
      environmentId: controlRef.environmentId,
      sessionId: controlRef.sessionId,
      executionId: controlRef.executionId,
      interactionId,
    },
  }
  const request: InteractionRequest = {
    ...material,
    requestDigest: interactionRequestDigest(material),
  }
  const receivedAt = '2026-08-19T00:00:00.000Z'
  const eventIdPrefix = createHash('sha256').update(controlRef.runId).digest('hex').slice(0, 16)
  const envelopes = [
    {
      runId: controlRef.runId,
      eventId: `fixture-${eventIdPrefix}-interaction`,
      sequence: 1,
      receivedAt,
      event: { type: 'interaction', request },
    },
    {
      runId: controlRef.runId,
      eventId: `fixture-${eventIdPrefix}-completed`,
      sequence: 2,
      receivedAt,
      event: { type: 'status', status: 'completed' },
    },
  ] as const
  return {
    request,
    frames: envelopes.map((envelope) => ({
      id: envelope.sequence,
      wire: `id: ${envelope.sequence}\nevent: ${envelope.event.type}\ndata: ${JSON.stringify(envelope)}\n\n`,
    })),
  }
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
  const sessionCreates: RuntimeBridgeSessionCreateRequest[] = []
  const continuations: RuntimeBridgeContinuationRequest[] = []
  const cancellations: RuntimeBridgeCancellationRequest[] = []
  const interactionResponses: RuntimeBridgeInteractionResponseRequest[] = []
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
    readonly provider: string
    readonly environmentId: string
    readonly sessionId: string
    readonly executionId: string
    readonly interaction?: InteractionRequest
  }
  interface RetainedFixtureSession {
    readonly id: string
    readonly model: string
    readonly createRequestDigest: string
    readonly body: Readonly<Record<string, unknown>>
    currentRunId?: string
    contextBoundary?: NativeContextBoundaryProof
  }
  interface RetainedFixtureContinuation {
    readonly requestDigest: string
    readonly outcome: Readonly<Record<string, unknown>>
  }
  const sessions = new Map<string, RetainedFixtureSession>()
  const runs = new Map<string, RetainedFixtureRun>()
  const continuationOutcomes = new Map<string, RetainedFixtureContinuation>()
  const interactionOutcomes = new Map<
    string,
    { readonly commandDigest: string; readonly command: InteractionResponseCommand }
  >()

  const contextBoundaryFor = (controlRef: AgentExactRunControlRef): NativeContextBoundaryProof => ({
    ...controlRef,
    boundary: { kind: 'revision', revision: `fixture-boundary:${controlRef.runId}` },
    observedAt: new Date().toISOString(),
  })

  const controlHeaders = (control: AgentExactRunControlRef) => ({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-run-id': control.runId,
    'x-run-request-digest': control.requestDigest,
    'x-run-provider': control.provider,
    'x-run-environment-id': control.environmentId,
    'x-run-session-id': control.sessionId,
    'x-run-execution-id': control.executionId,
  })

  const controlRefForRun = (run: RetainedFixtureRun): AgentExactRunControlRef => ({
    runId: run.id,
    requestDigest: run.digest as `sha256:${string}`,
    provider: run.provider,
    environmentId: run.environmentId,
    sessionId: run.sessionId,
    executionId: run.executionId,
  })

  const runHeaders = (run: RetainedFixtureRun) => controlHeaders(controlRefForRun(run))

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
    if (request.method === 'GET' && path === '/v1/capabilities') {
      const model = new URL(request.url ?? '/', 'http://runtime-bridge.test').searchParams.get(
        'model',
      )
      if (model === null || model.length === 0) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'model_required' } }))
        return
      }
      if (options.advertisedCapabilities === null) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'capabilities_unavailable' } }))
        return
      }
      const runner = harnessTypeSchema.safeParse(model.split('/', 1)[0])
      const advertisedCapabilities =
        options.advertisedCapabilities ??
        defaultCliBridgeCapabilities(runner.success ? runner.data : undefined)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(advertisedCapabilities))
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
    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/u.exec(path)
    if (request.method === 'GET' && sessionMatch !== null) {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? '')
      const session = sessions.get(sessionId)
      if (session === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'session_not_found' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: session.id,
          model: session.model,
          create_request_digest: session.createRequestDigest,
          context_boundary: session.contextBoundary ?? null,
        }),
      )
      return
    }
    if (request.method === 'POST' && path === '/v1/sessions') {
      const rawBody = await readBody(request)
      const body = JSON.parse(rawBody) as Record<string, unknown>
      const sessionId = body.id
      const model = body.model
      if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof model !== 'string') {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'invalid_session' } }))
        return
      }
      const createRequestDigest = canonicalCandidateDigest(body)
      const existing = sessions.get(sessionId)
      if (
        existing !== undefined &&
        (existing.model !== model || existing.createRequestDigest !== createRequestDigest)
      ) {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'session_idempotency_conflict' } }))
        return
      }
      const session =
        existing ??
        ({
          id: sessionId,
          model,
          createRequestDigest,
          body,
        } satisfies RetainedFixtureSession)
      sessions.set(sessionId, session)
      sessionCreates.push({ sessionId, body })
      response.writeHead(existing === undefined ? 201 : 200, {
        'content-type': 'application/json',
      })
      response.end(
        JSON.stringify({
          id: session.id,
          model: session.model,
          create_request_digest: session.createRequestDigest,
        }),
      )
      return
    }
    const sessionTurnsMatch = /^\/v1\/sessions\/([^/]+)\/turns$/u.exec(path)
    if (request.method === 'POST' && sessionTurnsMatch !== null) {
      const sessionId = decodeURIComponent(sessionTurnsMatch[1] ?? '')
      const session = sessions.get(sessionId)
      if (session === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'session_not_found' } }))
        return
      }
      const rawBody = await readBody(request)
      const body = JSON.parse(rawBody) as Record<string, unknown>
      const runId = body.run_id
      const executionId = body.execution_id
      const provider = body.provider
      const environmentId = body.environment_id
      if (
        typeof runId !== 'string' ||
        runId.length === 0 ||
        typeof executionId !== 'string' ||
        executionId.length === 0 ||
        typeof provider !== 'string' ||
        provider.length === 0 ||
        typeof environmentId !== 'string' ||
        environmentId.length === 0
      ) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'invalid_turn' } }))
        return
      }
      const digest = sha256(rawBody)
      const existing = runs.get(runId)
      if (existing !== undefined && existing.digest !== digest) {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'turn_idempotency_conflict' } }))
        return
      }
      const controlRef = AgentExactRunControlRefSchema.parse({
        runId,
        requestDigest: digest,
        provider,
        environmentId,
        sessionId,
        executionId,
      })
      const interaction =
        options.interaction === undefined
          ? undefined
          : canonicalInteractionFrames(controlRef, options.interaction)
      const frames =
        interaction?.frames ??
        runtimeResponseFrames(
          session.body,
          responseText(options.responseText, body),
          options.estimatedCostUsd,
          options.usage,
        )
      const hold = options.holdStreams === true || interaction !== undefined
      const run =
        existing ??
        ({
          id: runId,
          digest,
          body: session.body,
          provider,
          environmentId,
          sessionId,
          executionId,
          ...(interaction === undefined ? {} : { interaction: interaction.request }),
          frames: hold ? frames.slice(0, 1) : [...frames],
          pendingFrames: hold ? frames.slice(1) : [],
          readers: new Set<ServerResponse>(),
          status: hold ? 'running' : 'done',
          terminal: !hold,
        } satisfies RetainedFixtureRun)
      runs.set(runId, run)
      session.currentRunId = runId
      session.contextBoundary = contextBoundaryFor({
        runId,
        provider,
        environmentId,
        sessionId,
        executionId,
        requestDigest: run.digest as `sha256:${string}`,
      })
      requests.push({
        ...(authorization === undefined ? {} : { authorization }),
        body,
        rawBody,
        runId,
        sessionId,
      })
      response.writeHead(202, {
        ...runHeaders(run),
        'content-type': 'application/json',
      })
      response.end(
        JSON.stringify({
          session: {
            id: session.id,
            model: session.model,
            create_request_digest: session.createRequestDigest,
          },
          run: {
            id: run.id,
            sessionId,
            executionId,
            provider,
            environmentId,
            requestDigest: run.digest,
            status: run.status,
            terminal: run.terminal,
          },
        }),
      )
      return
    }
    const sessionContinueMatch = /^\/v1\/sessions\/([^/]+)\/continue$/u.exec(path)
    if (request.method === 'POST' && sessionContinueMatch !== null) {
      const sessionId = decodeURIComponent(sessionContinueMatch[1] ?? '')
      const session = sessions.get(sessionId)
      if (session === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'session_not_found' } }))
        return
      }
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>
      const continuationRequest = NativeContextContinuationRequestSchema.parse(body.request)
      NativeContextContinuationTurnSchema.parse(body.turn)
      const turn = body.turn as Readonly<Record<string, unknown>>
      const prior = continuationOutcomes.get(continuationRequest.operationId)
      if (prior !== undefined) {
        if (prior.requestDigest !== continuationRequest.requestDigest) {
          response.writeHead(409, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              acknowledgement: {
                operationId: continuationRequest.operationId,
                requestDigest: continuationRequest.requestDigest,
                status: 'conflict',
                historyMessagesSent: 0,
                existingRequestDigest: prior.requestDigest,
              },
            }),
          )
          return
        }
        const replay = structuredClone(prior.outcome)
        ;(replay.acknowledgement as Record<string, unknown>).status = 'replayed'
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(replay))
        return
      }
      if (
        continuationRequest.run.sessionId !== sessionId ||
        session.currentRunId !== continuationRequest.run.runId ||
        session.contextBoundary === undefined ||
        canonicalCandidateDigest(session.contextBoundary) !==
          canonicalCandidateDigest(continuationRequest.expectedBoundary)
      ) {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            acknowledgement: {
              operationId: continuationRequest.operationId,
              requestDigest: continuationRequest.requestDigest,
              status: 'boundary_mismatch',
              historyMessagesSent: 0,
              actualBoundary: session.contextBoundary,
            },
          }),
        )
        return
      }
      const runId = `native-${createHash('sha256')
        .update(continuationRequest.operationId)
        .digest('hex')}`
      const executionId = runId
      const requestDigest = canonicalCandidateDigest({
        sessionId,
        request: continuationRequest,
        turn,
      })
      const text = responseText(options.responseText, turn)
      const frames = runtimeResponseFrames(
        session.body,
        text,
        options.estimatedCostUsd,
        options.usage,
      )
      const run = {
        id: runId,
        digest: requestDigest,
        body: session.body,
        provider: continuationRequest.run.provider,
        environmentId: continuationRequest.run.environmentId,
        sessionId,
        executionId,
        frames: [...frames],
        pendingFrames: [],
        readers: new Set<ServerResponse>(),
        status: 'done',
        terminal: true,
      } satisfies RetainedFixtureRun
      const controlRef: AgentExactRunControlRef = {
        runId,
        provider: continuationRequest.run.provider,
        environmentId: continuationRequest.run.environmentId,
        sessionId,
        executionId,
        requestDigest,
      }
      const resultUsage = {
        inputTokens: options.usage?.promptTokens ?? 2,
        outputTokens: options.usage?.completionTokens ?? 3,
        totalTokens: (options.usage?.promptTokens ?? 2) + (options.usage?.completionTokens ?? 3),
        ...(options.usage?.cacheReadInputTokens === undefined
          ? {}
          : { cacheReadInputTokens: options.usage.cacheReadInputTokens }),
        ...(options.usage?.cacheCreationInputTokens === undefined
          ? {}
          : { cacheCreationInputTokens: options.usage.cacheCreationInputTokens }),
        ...(options.usage?.reasoningTokens === undefined
          ? {}
          : { reasoningTokens: options.usage.reasoningTokens }),
        ...(options.estimatedCostUsd === undefined ? {} : { cost: options.estimatedCostUsd }),
      }
      const outcome = {
        acknowledgement: {
          operationId: continuationRequest.operationId,
          requestDigest: continuationRequest.requestDigest,
          status: 'accepted',
          historyMessagesSent: 0,
          actualBoundary: continuationRequest.expectedBoundary,
        },
        result: {
          text,
          success: true,
          sessionId,
          usage: resultUsage,
          metadata: {
            runId,
            executionId,
            status: 'done',
            requestDigest,
            modelRequests: 1,
          },
        },
        controlRef,
      } as const
      runs.set(runId, run)
      session.currentRunId = runId
      session.contextBoundary = contextBoundaryFor(controlRef)
      continuationOutcomes.set(continuationRequest.operationId, {
        requestDigest: continuationRequest.requestDigest,
        outcome,
      })
      continuations.push({ sessionId, request: continuationRequest, turn, runId })
      response.writeHead(200, {
        ...runHeaders(run),
        'content-type': 'application/json',
      })
      response.end(JSON.stringify(outcome))
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
    const interactionResponseMatch = /^\/v1\/runs\/([^/]+)\/interactions\/([^/]+)\/respond$/u.exec(
      path,
    )
    if (request.method === 'POST' && interactionResponseMatch !== null) {
      const runId = decodeURIComponent(interactionResponseMatch[1] ?? '')
      const interactionId = decodeURIComponent(interactionResponseMatch[2] ?? '')
      const run = runs.get(runId)
      if (run === undefined || run.interaction === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'unknown_interaction' } }))
        return
      }
      const parsed = InteractionResponseCommandSchema.safeParse(JSON.parse(await readBody(request)))
      if (!parsed.success) {
        response.writeHead(400, {
          ...runHeaders(run),
          'content-type': 'application/json',
        })
        response.end(JSON.stringify({ error: { type: 'invalid_response' } }))
        return
      }
      const command = parsed.data
      const expectedBinding = {
        ...run.interaction.binding,
        requestDigest: run.interaction.requestDigest,
      }
      const bindingMatches =
        interactionId === run.interaction.id &&
        canonicalCandidateDigest(command.binding) === canonicalCandidateDigest(expectedBinding)
      if (!bindingMatches) {
        response.writeHead(409, {
          ...runHeaders(run),
          'content-type': 'application/json',
        })
        response.end(
          JSON.stringify({
            operationId: command.operationId,
            binding: command.binding,
            commandDigest: command.commandDigest,
            status: 'binding_mismatch',
          }),
        )
        return
      }
      interactionResponses.push({ runId, interactionId, command })
      const key = `${runId}:${interactionId}`
      const existing = interactionOutcomes.get(key)
      const status =
        existing === undefined
          ? 'accepted'
          : existing.commandDigest === command.commandDigest
            ? 'already_resolved_same'
            : 'already_resolved_different'
      if (existing === undefined) {
        interactionOutcomes.set(key, { commandDigest: command.commandDigest, command })
        completeRun(run)
      }
      response.writeHead(status === 'already_resolved_different' ? 409 : 200, {
        ...runHeaders(run),
        'content-type': 'application/json',
      })
      response.end(
        JSON.stringify({
          operationId: command.operationId,
          binding: command.binding,
          commandDigest: command.commandDigest,
          status,
        }),
      )
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
          provider: run.provider,
          environmentId: run.environmentId,
          sessionId: run.sessionId,
          executionId: run.executionId,
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
      const rawCancellation = await readBody(request)
      const parsedCancellation = AgentRunCancellationRequestSchema.safeParse(
        rawCancellation.length === 0 ? undefined : JSON.parse(rawCancellation),
      )
      if (!parsedCancellation.success || parsedCancellation.data.run.runId !== runId) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'invalid_cancellation' } }))
        return
      }
      const exactCancellation = parsedCancellation.data
      cancellations.push({
        runId,
        waitMs: Number.isFinite(waitMs) ? waitMs : 0,
        body: exactCancellation,
      })
      const configuredDelay = options.cancellation?.delayMs ?? 0
      if (configuredDelay > 0) await new Promise((resolve) => setTimeout(resolve, configuredDelay))
      const run = runs.get(runId)
      const controlRef = run === undefined ? exactCancellation.run : controlRefForRun(run)
      if (
        canonicalCandidateDigest(controlRef) !== canonicalCandidateDigest(exactCancellation.run)
      ) {
        response.writeHead(409, {
          ...controlHeaders(controlRef),
          'content-type': 'application/json',
        })
        response.end(
          JSON.stringify({
            operationId: exactCancellation.operationId,
            requestDigest: exactCancellation.requestDigest,
            run: exactCancellation.run,
            status: 'conflict',
            effect: 'unknown',
            message: 'fixture cancellation targeted another run identity',
            retryable: false,
          }),
        )
        return
      }
      if (options.cancellation?.mode === 'rejected') {
        response.writeHead(409, {
          ...controlHeaders(controlRef),
          'content-type': 'application/json',
        })
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
        ...controlHeaders(controlRef),
        'content-type': 'application/json',
      })
      response.end(
        JSON.stringify({
          operationId: exactCancellation.operationId,
          requestDigest: exactCancellation.requestDigest,
          run: exactCancellation.run,
          status: 'accepted',
          effect: cancellationEffect,
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
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'missing_run_id' } }))
      return
    }
    const runId = requestedRunId
    const existing = runs.get(runId)
    const digest = existing?.digest ?? sha256(rawBody)
    const provider = typeof body.provider === 'string' ? body.provider : undefined
    const environmentId = typeof body.environment_id === 'string' ? body.environment_id : undefined
    const sessionId =
      typeof body.session_id === 'string'
        ? body.session_id
        : typeof request.headers['x-session-id'] === 'string'
          ? request.headers['x-session-id']
          : undefined
    const executionId = typeof body.execution_id === 'string' ? body.execution_id : undefined
    if (
      provider === undefined ||
      environmentId === undefined ||
      sessionId === undefined ||
      executionId === undefined
    ) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'missing_exact_run_coordinates' } }))
      return
    }
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
      const controlRef = AgentExactRunControlRefSchema.parse({
        runId,
        requestDigest: digest,
        provider,
        environmentId,
        sessionId,
        executionId,
      })
      response.writeHead(200, {
        ...controlHeaders(controlRef),
        'content-type': 'application/json',
      })
      response.end(
        JSON.stringify(runtimeResponseResult(body, text, options.estimatedCostUsd, options.usage)),
      )
      return
    }
    const controlRef = AgentExactRunControlRefSchema.parse({
      runId,
      requestDigest: digest,
      provider,
      environmentId,
      sessionId,
      executionId,
    })
    const interaction =
      options.interaction === undefined
        ? undefined
        : canonicalInteractionFrames(controlRef, options.interaction)
    const frames =
      interaction?.frames ??
      runtimeResponseFrames(body, text, options.estimatedCostUsd, options.usage)
    const hold = options.holdStreams === true || interaction !== undefined
    const run =
      existing ??
      ({
        id: runId,
        digest,
        body,
        provider,
        environmentId,
        sessionId,
        executionId,
        ...(interaction === undefined ? {} : { interaction: interaction.request }),
        frames: hold ? frames.slice(0, 1) : [...frames],
        pendingFrames: hold ? frames.slice(1) : [],
        readers: new Set<ServerResponse>(),
        status: hold ? 'running' : 'done',
        terminal: !hold,
      } satisfies RetainedFixtureRun)
    runs.set(runId, run)
    if (hold) attachReader(run, response)
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
    sessionCreates,
    continuations,
    cancellations,
    interactionResponses,
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
