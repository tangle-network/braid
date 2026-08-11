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
  readonly holdStreams?: boolean
  readonly cancellation?: {
    readonly mode?: 'acknowledged' | 'rejected'
    readonly delayMs?: number
  }
}

export interface RuntimeBridgeCancellationRequest {
  readonly runId: string
  readonly waitMs: number
}

export interface RuntimeBridgeServer {
  readonly endpoint: string
  readonly requests: RuntimeBridgeRequest[]
  readonly cancellations: RuntimeBridgeCancellationRequest[]
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

function runtimeResponseStream(
  body: Readonly<Record<string, unknown>>,
  responseText: string,
  estimatedCostUsd?: number,
): string {
  const terminal = {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 2,
      completion_tokens: 3,
      cost_known: false,
      ...(estimatedCostUsd === undefined
        ? {}
        : { estimated_cost: estimatedCostUsd, cost_provenance: 'catalog-estimate' }),
    },
    profile_materialization: profileMaterialization(body),
  }
  return [
    'id: 1',
    `data: ${JSON.stringify({
      choices: [{ delta: { content: responseText }, finish_reason: null }],
    })}`,
    '',
    'id: 2',
    `data: ${JSON.stringify(terminal)}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n')
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
  const activeStreams = new Map<
    string,
    { readonly response: ServerResponse; readonly digest: string }
  >()
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
    const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/u.exec(path)
    if (request.method === 'POST' && cancelMatch !== null) {
      const runId = decodeURIComponent(cancelMatch[1] ?? '')
      const waitMs = Number(
        new URL(request.url ?? '/', 'http://runtime-bridge.test').searchParams.get('wait_ms') ??
          '0',
      )
      cancellations.push({ runId, waitMs: Number.isFinite(waitMs) ? waitMs : 0 })
      const configuredDelay = options.cancellation?.delayMs ?? 0
      if (configuredDelay > 0) await new Promise((resolve) => setTimeout(resolve, configuredDelay))
      const active = activeStreams.get(runId)
      const matchingRequest = requests.find((candidate) => candidate.runId === runId)
      const requestDigest =
        active?.digest ??
        (matchingRequest === undefined ? sha256('missing-run') : sha256(matchingRequest.rawBody))
      if (options.cancellation?.mode === 'rejected') {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'cancel_rejected' } }))
        return
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-run-id': runId,
        'x-run-request-digest': requestDigest,
      })
      response.end(
        JSON.stringify({
          terminal: true,
          run: { id: runId, requestDigest, terminal: true },
        }),
      )
      active?.response.end()
      return
    }
    if (request.method !== 'POST' || path !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }

    const rawBody = await readBody(request)
    const body = JSON.parse(rawBody) as Record<string, unknown>
    const runId = request.headers['x-run-id']
    if (typeof runId !== 'string' || runId.length === 0) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'missing_run_id' } }))
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
    const digest = sha256(rawBody)
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-run-id': runId,
      'x-run-request-digest': digest,
    })
    if (options.holdStreams) {
      activeStreams.set(runId, { response, digest })
      response.once('close', () => activeStreams.delete(runId))
      response.write(
        `id: 1\ndata: ${JSON.stringify({ choices: [{ delta: { content: responseText(options.responseText, body) }, finish_reason: null }] })}\n\n`,
      )
    } else {
      response.end(
        runtimeResponseStream(
          body,
          responseText(options.responseText, body),
          options.estimatedCostUsd,
        ),
      )
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    cancellations,
    close: async () => {
      for (const { response } of activeStreams.values()) response.end()
      await closeServer(server)
    },
  }
}
