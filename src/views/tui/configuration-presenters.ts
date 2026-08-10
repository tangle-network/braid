import type { SelectItem } from '@earendil-works/pi-tui'
import type { ConnectionSummary } from '../../app/connection-action-types.js'
import type { ProfileSummary } from '../../app/profiles.js'
import { isSensitiveFieldName, sanitizeTerminalText } from '../shared/sanitize.js'

export function profileSummariesFrom(value: unknown): readonly ProfileSummary[] {
  if (!isRecord(value) || !Array.isArray(value.profiles)) return []
  return value.profiles.filter(isProfileSummary)
}

export function connectionSummariesFrom(value: unknown): readonly ConnectionSummary[] {
  if (!isRecord(value) || !Array.isArray(value.connections)) return []
  return value.connections.filter(isConnectionSummary)
}

export function profileItems(
  profiles: readonly ProfileSummary[],
  activeName: string | undefined,
  activeId?: string,
): SelectItem[] {
  const matchingNames = profiles.filter((profile) => profile.name === activeName)
  return profiles.map((profile) => ({
    value: profile.id,
    label:
      activeId === profile.id ||
      (activeId === undefined && matchingNames.length === 1 && profile.name === activeName)
        ? `✓ ${safe(profile.name)}`
        : safe(profile.name),
    description: [
      profile.source.trusted ? 'trusted' : 'untrusted source',
      profile.source.writable ? 'writable' : 'read-only',
      safe(profile.source.label),
      profile.runner === undefined ? 'runner default' : safe(profile.runner),
      profile.model === undefined ? 'model default' : safe(profile.model),
    ].join(' · '),
  }))
}

export function connectionItems(
  connections: readonly ConnectionSummary[],
  activeName: string | undefined,
  activeId?: string,
): SelectItem[] {
  const matchingNames = connections.filter((connection) => connection.name === activeName)
  return connections.map((connection) => ({
    value: connection.id,
    label:
      activeId === connection.id ||
      (activeId === undefined && matchingNames.length === 1 && connection.name === activeName)
        ? `✓ ${safe(connection.name)}`
        : safe(connection.name),
    description: [
      connectionKind(connection.kind),
      connection.health.status,
      `model ${connection.modelVerification?.status ?? 'unverified'}`,
      connection.credentialConfigured ? 'credential ready' : 'credential needed',
      connection.ready ? 'ready' : 'not ready',
      capabilitySummary(connection),
    ]
      .filter((value) => value.length > 0)
      .join(' · '),
  }))
}

export function profileDetailLines(profile: ProfileSummary | undefined): string[] {
  if (profile === undefined) return ['No profile details loaded.']
  return [
    `source ${safe(profile.source.label)} · ${profile.source.trusted ? 'trusted' : 'untrusted'} · ${profile.source.writable ? 'writable' : 'read-only'}`,
    `runner ${safe(profile.runner ?? 'provider default')} · model ${safe(profile.model ?? 'provider default')}`,
    profileModelControls(profile),
    `digest ${shortDigest(profile.digest)}`,
  ]
}

export function profileCompactDetail(profile: ProfileSummary | undefined): string {
  if (profile === undefined) return 'No profile details loaded.'
  return [
    `runner ${safe(profile.runner ?? 'provider default')}`,
    `model ${safe(profile.model ?? 'provider default')}`,
    profileModelControls(profile),
    profile.source.trusted ? 'trusted' : 'untrusted source',
    profile.source.writable ? 'writable' : 'read-only',
    `digest ${shortDigest(profile.digest)}`,
  ].join(' · ')
}

export function connectionDetailLines(connection: ConnectionSummary | undefined): string[] {
  if (connection === undefined) return ['No connection details loaded.']
  const verification = connection.modelVerification
  return [
    `kind ${connectionKind(connection.kind)} · ${connection.health.status}`,
    `endpoint ${safeEndpoint(connection.endpoint)} · credential ${connection.credentialConfigured ? 'configured' : 'not configured'}`,
    `model ${verification?.status ?? 'unverified'} · ${connection.ready ? 'ready' : 'not ready'}`,
    `capabilities ${capabilitySummary(connection) || 'not reported'}`,
  ]
}

export function connectionCompactDetail(connection: ConnectionSummary | undefined): string {
  if (connection === undefined) return 'No connection details loaded.'
  return [
    connection.health.status,
    `model ${connection.modelVerification?.status ?? 'unverified'}`,
    connection.credentialConfigured ? 'credential configured' : 'credential not configured',
    connection.ready ? 'ready' : 'not ready',
    capabilitySummary(connection) || 'capabilities not reported',
  ].join(' · ')
}

export function capabilitySummary(connection: ConnectionSummary): string {
  const actions = Object.entries(connection.capabilities?.actions ?? {})
    .filter(([, available]) => available)
    .map(([name]) => name)
  const hints = connection.capabilityHints
  const values = actions.length > 0 ? actions : hints
  return values.length > 0 ? values.map(safe).join(', ') : ''
}

export function connectionKind(kind: ConnectionSummary['kind'] | string): string {
  switch (kind) {
    case 'cli-bridge':
      return 'CLI Bridge'
    case 'tangle-inference':
      return 'Tangle inference'
    case 'tangle-sandbox':
      return 'Tangle sandbox'
    default:
      return safe(kind)
  }
}

export function shortDigest(value: string): string {
  const safeValue = safe(value)
  if (safeValue.length <= 24) return safeValue
  return `${safeValue.slice(0, 15)}…${safeValue.slice(-8)}`
}

export function safeEndpoint(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return 'provider default'
  try {
    const parsed = new URL(value)
    return safe(`${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`)
  } catch {
    return 'endpoint unavailable'
  }
}

export function safeFieldValue(label: string, value: string, secret: boolean): string {
  if (secret || isSensitiveFieldName(label)) return '[secret value hidden]'
  if (/endpoint|url/iu.test(label)) return safeEndpoint(value)
  return safe(value)
}

export function safe(value: string): string {
  return sanitizeTerminalText(value)
}

export function actionMessage(
  result: {
    readonly kind: string
    readonly notice?: string
    readonly reason?: string
    readonly message?: string
  },
  success: string,
): string {
  if (result.kind === 'accepted') return safe(result.notice ?? success)
  return safe(
    result.kind === 'error'
      ? (result.message ?? 'Action failed')
      : (result.reason ?? 'Action unavailable'),
  )
}

export const REFRESH_TIMEOUT = Symbol('refresh-timeout')

export async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof REFRESH_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof REFRESH_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(REFRESH_TIMEOUT), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isProfileSummary(value: unknown): value is ProfileSummary {
  if (!isRecord(value)) return false
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.digest !== 'string' ||
    !Array.isArray(value.tags) ||
    !Array.isArray(value.tools) ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.connections) ||
    (value.description !== undefined && typeof value.description !== 'string') ||
    (value.runner !== undefined && typeof value.runner !== 'string') ||
    (value.model !== undefined && typeof value.model !== 'string') ||
    (value.reasoningEffort !== undefined && typeof value.reasoningEffort !== 'string') ||
    (value.maxOutputTokens !== undefined &&
      (typeof value.maxOutputTokens !== 'number' ||
        !Number.isSafeInteger(value.maxOutputTokens) ||
        value.maxOutputTokens <= 0))
  )
    return false
  const source = value.source
  return (
    isRecord(source) &&
    typeof source.label === 'string' &&
    typeof source.writable === 'boolean' &&
    typeof source.trusted === 'boolean'
  )
}

function profileModelControls(profile: ProfileSummary): string {
  const effort = safe(profile.reasoningEffort ?? 'provider default')
  const output =
    profile.maxOutputTokens === undefined
      ? 'provider default'
      : `${profile.maxOutputTokens.toLocaleString('en-US')} tokens`
  return `thinking ${effort} · max output ${output}`
}

function isConnectionSummary(value: unknown): value is ConnectionSummary {
  if (!isRecord(value)) return false
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.kind !== 'string' ||
    typeof value.credentialConfigured !== 'boolean' ||
    typeof value.ready !== 'boolean' ||
    !isRecord(value.health) ||
    typeof value.health.status !== 'string' ||
    !Array.isArray(value.capabilityHints) ||
    !value.capabilityHints.every((hint) => typeof hint === 'string') ||
    (value.endpoint !== undefined && typeof value.endpoint !== 'string')
  )
    return false
  const verification = value.modelVerification
  return (
    verification === undefined ||
    (isRecord(verification) &&
      typeof verification.model === 'string' &&
      typeof verification.status === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
