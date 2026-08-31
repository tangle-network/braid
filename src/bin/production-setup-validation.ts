import {
  harnessHonorsEffort,
  harnessHonorsModel,
} from '../adapters/agent-interface/harness-runtime.js'
import { cliBridgeModelValidationRequest } from '../adapters/connections/cli-bridge-model-validation.js'
import { readConnectionCredential } from '../adapters/connections/production-connections.js'
import type {
  ConfigurationEffectiveValues,
  ConfigurationSelection,
} from '../app/configuration-session.js'
import { compactWorkspaceRepositoryUrl } from '../app/workspace-request.js'
import {
  DEFAULT_MODEL_VALIDATION_TIMEOUT_MS,
  displayBridgeEndpoint,
  MAX_MODEL_VALIDATION_BODY_BYTES,
  ProductionBridgeRequestError,
  requestBridge,
  safeBridgeDetail,
} from './production-bridge-client.js'
import type { ProductionSetupVerification } from './production-setup-types.js'
import type { ProductionStartupLoadOptions } from './production-startup.js'

function validationTimeout(options: ProductionStartupLoadOptions): number {
  const timeout = options.modelValidationTimeoutMs ?? DEFAULT_MODEL_VALIDATION_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10 * 60_000) {
    throw new Error('CLI Bridge model validation timeout must be an integer from 1 to 600000 ms')
  }
  return timeout
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function completionContent(body: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return undefined
  const first = parsed.choices[0]
  if (!isRecord(first)) return undefined
  const message = isRecord(first.message) ? first.message : undefined
  if (typeof message?.content === 'string' && message.content.trim().length > 0) {
    return message.content.trim()
  }
  if (Array.isArray(message?.content)) {
    const text = message.content
      .flatMap((part) => (isRecord(part) && typeof part.text === 'string' ? [part.text] : []))
      .join('')
      .trim()
    if (text.length > 0) return text
  }
  if (typeof first.text === 'string' && first.text.trim().length > 0) return first.text.trim()
  return undefined
}

function isExactValidationMarker(body: string): boolean {
  return completionContent(body)?.replace(/\s+/gu, ' ').trim() === 'OK'
}

function providerFailure(endpoint: string, model: string, status: number, body: string): Error {
  const detail = safeBridgeDetail(body)
  if (status === 501 && /not_configured/iu.test(body)) {
    return new Error(
      `CLI Bridge at ${endpoint} advertised ${model} but returned 501 not_configured${detail === undefined ? '' : ` (${detail})`}. Configure the selected bridge backend and its local subscription credentials, then retry setup. Discovery is not authentication proof.`,
    )
  }
  if (status === 401 || status === 403) {
    return new Error(
      `CLI Bridge at ${endpoint} rejected ${model} with HTTP ${status}${detail === undefined ? '' : ` (${detail})`}. Sign in or configure the selected bridge backend credentials, then retry setup.`,
    )
  }
  return new Error(
    `CLI Bridge model validation at ${endpoint} failed for ${model} with HTTP ${status}${detail === undefined ? '' : ` (${detail})`}. Retry after the bridge reports a runnable backend.`,
  )
}

function requestFailure(endpoint: string, model: string, timeoutMs: number, error: unknown): Error {
  if (error instanceof ProductionBridgeRequestError && error.code === 'BRIDGE_TIMEOUT') {
    return new Error(
      `CLI Bridge model validation at ${endpoint} timed out after ${timeoutMs} ms for ${model}. Confirm the bridge backend is configured, then retry setup.`,
      { cause: error },
    )
  }
  const detail = error instanceof Error ? error.message : 'the request failed'
  return new Error(
    `CLI Bridge model validation at ${endpoint} could not reach ${model}: ${detail}. Start the bridge at the selected endpoint, configure its backend, then retry setup.`,
    { cause: error },
  )
}

async function validationCredential(
  options: ProductionStartupLoadOptions,
  selection: ConfigurationSelection,
  endpoint: string,
): Promise<string | undefined> {
  if (selection.connection.credentialRef === undefined) return options.bridgeAuth
  return readConnectionCredential(
    selection.connection,
    {
      ...(options.credentialStore === undefined ? {} : { credentials: options.credentialStore }),
      ...(options.credentialRefResolver === undefined
        ? {}
        : { credentialRefResolver: options.credentialRefResolver }),
    },
    endpoint,
  )
}

/** Runs one bounded, non-streaming request and requires a real completion body. */
export async function validateProductionSelection(
  options: ProductionStartupLoadOptions,
  selection: ConfigurationSelection,
): Promise<ProductionSetupVerification> {
  if (selection.connection.kind !== 'cli-bridge') {
    return {
      status: 'unverified',
      detail: `Model validation is not available for ${selection.connection.kind}; provider authentication remains unverified.`,
    }
  }
  const profile = selection.profile.profile
  const authoredModel = profile.model?.default?.trim()
  if (!authoredModel)
    throw new Error('Setup cannot validate a profile without a model.default value')
  if (profile.harness === undefined) {
    throw new Error('Setup cannot validate a CLI Bridge profile without a runner')
  }
  const validationRequest = cliBridgeModelValidationRequest(profile)
  const model = validationRequest.model
  const endpoint = selection.connection.endpoint
  if (!endpoint) {
    throw new Error(
      `CLI Bridge model validation cannot run because the selected connection has no endpoint; configure the selected CLI Bridge endpoint and retry setup.`,
    )
  }
  const timeoutMs = validationTimeout(options)
  try {
    const auth = await validationCredential(options, selection, endpoint)
    const response = await requestBridge({
      endpoint,
      path: 'chat/completions',
      ...(options.fetch === undefined ? {} : { fetcher: options.fetch }),
      ...(auth === undefined ? {} : { auth }),
      timeoutMs,
      maxBodyBytes: MAX_MODEL_VALIDATION_BODY_BYTES,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validationRequest),
      },
    })
    const selectedEndpoint = displayBridgeEndpoint(endpoint)
    if (!response.ok) throw providerFailure(selectedEndpoint, model, response.status, response.body)
    if (!isExactValidationMarker(response.body)) {
      throw new Error(
        `CLI Bridge model validation at ${selectedEndpoint} returned HTTP ${response.status} without the exact OK completion for ${model}; retry after the bridge returns the requested validation marker.`,
      )
    }
    return {
      status: 'verified',
      detail: `Bounded model validation succeeded for ${model} at ${selectedEndpoint}.`,
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CLI Bridge')) throw error
    throw requestFailure(displayBridgeEndpoint(endpoint), model, timeoutMs, error)
  }
}

/** Shows effective values and names dimensions the chosen provider cannot honor. */
export function describeProductionSelection(
  selection: ConfigurationSelection,
  workspace: string,
  verification: ProductionSetupVerification = {
    status: 'unverified',
    detail: 'Provider authentication has not been validated.',
  },
): ConfigurationEffectiveValues {
  const profile = selection.profile.profile
  const runner = profile.harness ?? 'provider default (not pinned)'
  const model = profile.model?.default ?? 'unsupported: no model configured'
  const effort = profile.model?.reasoningEffort ?? 'provider default (not pinned)'
  const unsupported: string[] = []
  if (profile.harness === undefined) unsupported.push('runner override (unsupported: not pinned)')
  if (profile.model?.default === undefined)
    unsupported.push('model override (unsupported: not configured)')
  if (profile.model?.reasoningEffort === undefined)
    unsupported.push('reasoning effort override (unsupported: not pinned)')
  if (profile.harness !== undefined && !harnessHonorsModel(profile.harness))
    unsupported.push(`model override (unsupported by ${profile.harness})`)
  if (profile.harness !== undefined && !harnessHonorsEffort(profile.harness))
    unsupported.push(`effort override (unsupported by ${profile.harness})`)
  if (selection.connection.kind === 'tangle-sandbox') {
    return {
      runner,
      model,
      effort,
      workdir:
        selection.workspaceRequest?.cwd === undefined
          ? 'repository root'
          : selection.workspaceRequest.cwd,
      ...(selection.workspaceRequest === undefined
        ? {}
        : { workspaceRequest: workspaceSummary(selection.workspaceRequest) }),
      verification: `${verification.status}: ${verification.detail}`,
      unsupported,
    }
  }
  unsupported.push(`provider workdir placement (unsupported by ${selection.connection.kind})`)
  return {
    runner,
    model,
    effort,
    workdir: workspace,
    verification: `${verification.status}: ${verification.detail}`,
    unsupported,
  }
}

function workspaceSummary(
  request: ConfigurationSelection['workspaceRequest'],
): NonNullable<ConfigurationEffectiveValues['workspaceRequest']> {
  if (request === undefined) return {}
  const repoUrl =
    request.repoUrl === undefined ? undefined : compactWorkspaceRepositoryUrl(request.repoUrl)
  return {
    ...(request.environment === undefined ? {} : { environment: request.environment }),
    ...(request.image === undefined ? {} : { image: request.image }),
    ...(repoUrl === undefined ? {} : { repoUrl }),
    ...(request.gitRef === undefined ? {} : { gitRef: request.gitRef }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
  }
}
