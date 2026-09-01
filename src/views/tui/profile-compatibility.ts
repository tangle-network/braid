import { type Component, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'

const MAX_VALUE_CHARS = 256

export interface ProfileCompatibilityResult {
  readonly authoredProfile?: unknown
  readonly runner?: unknown
  readonly model?: unknown
  readonly compatibility?: {
    readonly modelSupported?: unknown
    readonly suggestedRunner?: unknown
    readonly suggestedModel?: unknown
  }
}

/**
 * Render profile compatibility as plain, bounded terminal lines.
 *
 * This deliberately accepts a structural result instead of importing the
 * profile resolver so installed-package evaluators can reuse the same text.
 */
export function profileCompatibilityTextLines(
  result: ProfileCompatibilityResult | null | undefined,
  width = 80,
): readonly string[] {
  const maxWidth = normalizedWidth(width)
  const state = readCompatibilityState(result)
  const lines =
    state === undefined
      ? unavailableLines()
      : state.kind === 'supported'
        ? supportedLines(state)
        : incompatibleLines(state)
  return lines.flatMap((line) => wrapTextWithAnsi(line, maxWidth))
}

export class ProfileCompatibilityPanel implements Component {
  #result: ProfileCompatibilityResult | null | undefined

  constructor(result?: ProfileCompatibilityResult | null) {
    this.#result = result
  }

  setResult(result: ProfileCompatibilityResult | null | undefined): void {
    this.#result = result
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [...profileCompatibilityTextLines(this.#result, width)]
  }
}

interface SupportedValues {
  readonly kind: 'supported'
  readonly profileName: string
  readonly runner: string
  readonly model: string
}

interface UnsupportedValues {
  readonly kind: 'unsupported'
  readonly profileName: string
  readonly runner: string
  readonly model: string
  readonly suggestedRunner: string
  readonly suggestedModel: string
}

type CompatibilityState = SupportedValues | UnsupportedValues

function readCompatibilityState(
  result: ProfileCompatibilityResult | null | undefined,
): CompatibilityState | undefined {
  if (!result || typeof result !== 'object') return undefined
  const profile = asRecord(result.authoredProfile)
  const compatibility = asRecord(result.compatibility)
  if (!profile || !compatibility) return undefined
  const runner = safeValue(result.runner)
  const model = safeValue(result.model)
  if (!runner || !model) return undefined
  const profileName = safeValue(profile.name) ?? 'unnamed'
  if (compatibility.modelSupported === true) {
    return { kind: 'supported', profileName, runner, model }
  }
  if (compatibility.modelSupported !== false) return undefined
  const suggestedRunner = safeValue(compatibility.suggestedRunner)
  const suggestedModel = safeValue(compatibility.suggestedModel)
  if (!suggestedRunner || !suggestedModel) return undefined
  if (suggestedRunner === runner || suggestedModel === model) return undefined
  return {
    kind: 'unsupported',
    profileName,
    runner,
    model,
    suggestedRunner,
    suggestedModel,
  }
}

function supportedLines(values: SupportedValues): readonly string[] {
  return [
    'profile compatibility',
    `supported pair: runner=${values.runner} · model=${values.model}`,
    `authored profile "${values.profileName}" remains unchanged`,
  ]
}

function incompatibleLines(values: UnsupportedValues): readonly string[] {
  return [
    'profile compatibility',
    `unsupported pair: runner=${values.runner} · model=${values.model}`,
    `authored profile "${values.profileName}" remains unchanged`,
    'choose one explicit change:',
    `1. change runner to ${values.suggestedRunner} to keep model ${values.model}`,
    `2. change model to ${values.suggestedModel} to keep runner ${values.runner}`,
  ]
}

function unavailableLines(): readonly string[] {
  return [
    'profile compatibility unavailable',
    'runner/model compatibility data is incomplete; no automatic change was made.',
    'authored profile remains unchanged.',
  ]
}

function safeValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const sanitized = sanitizeTerminalText(value)
    .replace(/[\t\r\n]+/gu, ' ')
    .trim()
  return sanitized.length > 0 && sanitized.length <= MAX_VALUE_CHARS ? sanitized : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizedWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80
}
