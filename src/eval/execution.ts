import { createChatClient } from '@tangle-network/agent-eval'
import type {
  ChatCallOpts,
  ChatClient,
  ChatRequest,
  ChatResponse,
} from '@tangle-network/agent-eval'
import type { EvalProviderIdentity, RecordedJudgeCall } from './types.js'
import { evalSha256, redactEvalValue } from './records.js'

export const DEFAULT_EVAL_BRIDGE_URL = 'http://127.0.0.1:3344/v1'
export const DEFAULT_EVAL_MODEL = 'opencode/zai-coding-plan/glm-5.2'
export const DEFAULT_EVAL_CALL_TIMEOUT_MS = 120_000
export const DEFAULT_EVAL_TOTAL_TIMEOUT_MS = 15 * 60_000

export interface EvalRouteConfig {
  readonly baseUrl: string
  readonly model: string
  readonly bearer?: string
  readonly timeoutMs: number
  readonly totalTimeoutMs: number
}

export interface EvalRouteReady {
  readonly status: 'ready'
  readonly config: EvalRouteConfig
  readonly provider: EvalProviderIdentity
  readonly health: unknown
  readonly models: readonly string[]
}

export interface EvalRouteUnavailable {
  readonly status: 'unavailable'
  readonly config: EvalRouteConfig
  readonly provider: EvalProviderIdentity
  readonly reason: string
  readonly health: unknown | null
  readonly models: readonly string[]
}

export type EvalRouteProbe = EvalRouteReady | EvalRouteUnavailable

function cleanBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password)
    throw new Error('BRAID_EVAL_BRIDGE_URL cannot include credentials')
  if (url.search || url.hash)
    throw new Error('BRAID_EVAL_BRIDGE_URL cannot include query or fragment')
  const pathname = url.pathname.replace(/\/+$/u, '')
  if (pathname !== '/v1') throw new Error('BRAID_EVAL_BRIDGE_URL must end in /v1')
  return `${url.origin}${pathname}`
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? String(fallback))
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`)
  return parsed
}

export function readEvalRouteConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EvalRouteConfig {
  const baseUrl = cleanBaseUrl(env.BRAID_EVAL_BRIDGE_URL ?? DEFAULT_EVAL_BRIDGE_URL)
  const model = (env.BRAID_EVAL_MODEL ?? DEFAULT_EVAL_MODEL).trim()
  if (model.length === 0) throw new Error('BRAID_EVAL_MODEL must be non-empty')
  const timeoutMs = positiveNumber(
    env.BRAID_EVAL_TIMEOUT_MS,
    DEFAULT_EVAL_CALL_TIMEOUT_MS,
    'BRAID_EVAL_TIMEOUT_MS',
  )
  const totalTimeoutMs = positiveNumber(
    env.BRAID_EVAL_TOTAL_TIMEOUT_MS,
    DEFAULT_EVAL_TOTAL_TIMEOUT_MS,
    'BRAID_EVAL_TOTAL_TIMEOUT_MS',
  )
  const bearer = env.BRAID_EVAL_BEARER?.trim()
  return {
    baseUrl,
    model,
    ...(bearer === undefined || bearer.length === 0 ? {} : { bearer }),
    timeoutMs,
    totalTimeoutMs,
  }
}

export function providerIdentity(config: EvalRouteConfig): EvalProviderIdentity {
  return {
    transport: 'cli-bridge',
    baseUrl: config.baseUrl,
    model: config.model,
    endpointSha256: evalSha256(config.baseUrl),
    bearerPresent: config.bearer !== undefined,
  }
}

function healthUrl(baseUrl: string): string {
  return `${baseUrl.slice(0, -'/v1'.length)}/health`
}

async function jsonFetch(
  url: string,
  config: EvalRouteConfig,
  fetchImpl: typeof fetch,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: config.bearer === undefined ? {} : { authorization: `Bearer ${config.bearer}` },
      signal: controller.signal,
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { response, body }
  } finally {
    clearTimeout(timer)
  }
}

function modelIds(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return []
  const data = (value as { readonly data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const id = (entry as { readonly id?: unknown }).id
    return typeof id === 'string' ? [id] : []
  })
}

export async function probeCliBridge(
  config: EvalRouteConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<EvalRouteProbe> {
  const provider = providerIdentity(config)
  let health: unknown = null
  let models: string[] = []
  try {
    const healthResult = await jsonFetch(healthUrl(config.baseUrl), config, fetchImpl)
    health = redactEvalValue(healthResult.body)
    if (!healthResult.response.ok) {
      return {
        status: 'unavailable',
        config,
        provider,
        reason: `CLI Bridge health returned HTTP ${healthResult.response.status}`,
        health,
        models,
      }
    }
    const modelsResult = await jsonFetch(`${config.baseUrl}/models`, config, fetchImpl)
    models = modelIds(modelsResult.body)
    if (!modelsResult.response.ok) {
      return {
        status: 'unavailable',
        config,
        provider,
        reason: `CLI Bridge model discovery returned HTTP ${modelsResult.response.status}`,
        health,
        models,
      }
    }
    if (!models.includes(config.model)) {
      return {
        status: 'unavailable',
        config,
        provider,
        reason: `CLI Bridge does not advertise required model ${config.model}`,
        health,
        models,
      }
    }
    return { status: 'ready', config, provider, health, models }
  } catch (error) {
    return {
      status: 'unavailable',
      config,
      provider,
      reason: error instanceof Error ? error.message : String(error),
      health,
      models,
    }
  }
}

export function createEvalChatClient(config: EvalRouteConfig): ChatClient {
  return createChatClient({
    transport: 'cli-bridge',
    baseUrl: config.baseUrl,
    defaultModel: config.model,
    maximumAttempts: 1,
    ...(config.bearer === undefined ? {} : { bearer: config.bearer }),
  })
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

function boundedOptions(
  options: ChatCallOpts | undefined,
  callTimeoutMs: number,
  totalDeadline: number,
): { readonly options: ChatCallOpts; readonly cleanup: () => void } {
  const controller = new AbortController()
  const parent = options?.signal
  const onParentAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted === true) onParentAbort()
  else parent?.addEventListener('abort', onParentAbort, { once: true })
  const remaining = Math.max(0, totalDeadline - Date.now())
  const timeoutMs = Math.min(callTimeoutMs, remaining)
  const timer = setTimeout(
    () =>
      controller.abort(
        abortError(
          timeoutMs === remaining ? 'eval total timeout exceeded' : 'eval call timeout exceeded',
        ),
      ),
    timeoutMs,
  )
  return {
    options: { ...(options ?? {}), signal: controller.signal },
    cleanup: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
  }
}

export function recordingChatClient(
  client: ChatClient,
  calls: RecordedJudgeCall[],
  limits: { readonly callTimeoutMs: number; readonly totalTimeoutMs: number },
): ChatClient {
  const totalDeadline = Date.now() + limits.totalTimeoutMs
  const wrapped: ChatClient = {
    transport: client.transport,
    chat: async (request: ChatRequest, options?: ChatCallOpts): Promise<ChatResponse> => {
      const startedAt = new Date().toISOString()
      const started = Date.now()
      if (Date.now() >= totalDeadline) {
        const error = abortError('eval total timeout exceeded before judge call')
        calls.push({
          callId: options?.idempotencyKey ?? null,
          request: redactEvalValue(request),
          response: null,
          error: { name: error.name, message: error.message },
          startedAt,
          finishedAt: new Date().toISOString(),
          wallTimeMs: 0,
        })
        throw error
      }
      const bounded = boundedOptions(options, limits.callTimeoutMs, totalDeadline)
      try {
        const response = await client.chat(request, bounded.options)
        calls.push({
          callId: options?.idempotencyKey ?? null,
          request: redactEvalValue(request),
          response: redactEvalValue(response),
          error: null,
          startedAt,
          finishedAt: new Date().toISOString(),
          wallTimeMs: Date.now() - started,
        })
        return response
      } catch (error) {
        calls.push({
          callId: options?.idempotencyKey ?? null,
          request: redactEvalValue(request),
          response: null,
          error: {
            name: error instanceof Error ? error.name : 'UnknownError',
            message: error instanceof Error ? error.message : String(error),
          },
          startedAt,
          finishedAt: new Date().toISOString(),
          wallTimeMs: Date.now() - started,
        })
        throw error
      } finally {
        bounded.cleanup()
      }
    },
  }
  if (client.defaultModel !== undefined)
    (wrapped as { defaultModel: string }).defaultModel = client.defaultModel
  if (client.maximumAttempts !== undefined)
    (wrapped as { maximumAttempts: number }).maximumAttempts = client.maximumAttempts
  return wrapped
}
