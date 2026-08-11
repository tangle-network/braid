import type {
  ChatCallOpts,
  ChatClient,
  ChatRequest,
  ChatResponse,
} from '@tangle-network/agent-eval'
import { type AgentProfile, agentProfileSchema } from '@tangle-network/agent-interface'
import { profileChatClient } from '@tangle-network/agent-runtime/kernel'
import { evalSha256, redactEvalValue } from './records.js'
import type { EvalProviderIdentity, RecordedJudgeCall } from './types.js'

export const DEFAULT_EVAL_BASE_URL = 'https://router.tangle.tools/v1'
export const DEFAULT_EVAL_MODEL = 'glm-5.2'
export const EVAL_TOTAL_COMPLETION_TOKENS = 2_048
export const DEFAULT_EVAL_CALL_TIMEOUT_MS = 120_000
export const DEFAULT_EVAL_TOTAL_TIMEOUT_MS = 15 * 60_000

export interface EvalRouteConfig {
  readonly baseUrl: string
  readonly model: string
  readonly apiKey?: string
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
    throw new Error('BRAID_EVAL_BASE_URL cannot include credentials')
  if (url.search || url.hash)
    throw new Error('BRAID_EVAL_BASE_URL cannot include query or fragment')
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('BRAID_EVAL_BASE_URL must use HTTP or HTTPS')
  const pathname = url.pathname.replace(/\/+$/u, '')
  if (pathname !== '/v1') throw new Error('BRAID_EVAL_BASE_URL must end in /v1')
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
  const baseUrl = cleanBaseUrl(env.BRAID_EVAL_BASE_URL ?? DEFAULT_EVAL_BASE_URL)
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
  const apiKey = env.BRAID_EVAL_API_KEY?.trim()
  return {
    baseUrl,
    model,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    timeoutMs,
    totalTimeoutMs,
  }
}

export function providerIdentity(config: EvalRouteConfig): EvalProviderIdentity {
  return {
    transport: 'custom',
    baseUrl: config.baseUrl,
    model: config.model,
    endpointSha256: evalSha256(config.baseUrl),
    bearerPresent: config.apiKey !== undefined,
  }
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
      headers: config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` },
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

export async function probeEvalRoute(
  config: EvalRouteConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<EvalRouteProbe> {
  const provider = providerIdentity(config)
  const health: unknown = null
  let models: string[] = []
  if (config.apiKey === undefined) {
    return {
      status: 'unavailable',
      config,
      provider,
      reason: 'BRAID_EVAL_API_KEY is required for the semantic release judge',
      health,
      models,
    }
  }
  try {
    const modelsResult = await jsonFetch(`${config.baseUrl}/models`, config, fetchImpl)
    models = modelIds(modelsResult.body)
    if (!modelsResult.response.ok) {
      return {
        status: 'unavailable',
        config,
        provider,
        reason: `Eval Router model discovery returned HTTP ${modelsResult.response.status}`,
        health,
        models,
      }
    }
    if (!models.includes(config.model)) {
      return {
        status: 'unavailable',
        config,
        provider,
        reason: `Eval Router does not advertise required model ${config.model}`,
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

type InjectedRouterCompletion = (
  body: Record<string, unknown>,
  request?: {
    readonly headers: Readonly<Record<string, string>>
    readonly signal?: AbortSignal
  },
) => Promise<unknown>

export function evalJudgeProfile(config: EvalRouteConfig): AgentProfile {
  const disablesThinking = /(?:^|\/)glm-/iu.test(config.model)
  const profile = {
    name: 'Braid semantic release judge',
    description: 'Scores installed Braid output against held-out release criteria.',
    version: '0.1.0',
    harness: 'cli-base',
    model: {
      provider: 'tangle-router',
      default: config.model,
      reasoningEffort: 'none',
      metadata: {
        temperature: 0,
        maxTokens: EVAL_TOTAL_COMPLETION_TOKENS,
        retry: {
          maxAttempts: 3,
          initialBackoffMs: 1_000,
          maxBackoffMs: 2_000,
          jitter: 0,
          requestTimeoutMs: config.timeoutMs,
        },
        extraBody: {
          // Router treats this field as the hard ceiling over visible and reasoning tokens.
          max_completion_tokens: EVAL_TOTAL_COMPLETION_TOKENS,
          // GLM enables thinking by default and does not honor reasoning_effort: none.
          ...(disablesThinking ? { thinking: { type: 'disabled' } } : {}),
        },
      },
    },
  } satisfies AgentProfile
  agentProfileSchema.parse(profile)
  return profile
}

export function createEvalChatClient(
  config: EvalRouteConfig,
  complete?: InjectedRouterCompletion,
): ChatClient {
  if (config.apiKey === undefined)
    throw new Error('BRAID_EVAL_API_KEY is required before creating the semantic judge')
  return profileChatClient({
    profile: evalJudgeProfile(config),
    context: 'Braid semantic release judge',
    executor: {
      backend: 'router',
      routerBaseUrl: config.baseUrl,
      routerKey: config.apiKey,
      ...(complete === undefined ? {} : { complete }),
    },
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
