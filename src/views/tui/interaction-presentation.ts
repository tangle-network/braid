import {
  type Component,
  CURSOR_MARKER,
  Input,
  type KeyId,
  matchesKey,
  TruncatedText,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { InteractionOutcome, InteractionView } from '../shared/models.js'
import { sanitizeDiff, sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

const OUTCOME_KEYS = [
  'alt+1',
  'alt+2',
  'alt+3',
  'alt+4',
  'alt+5',
  'alt+6',
  'alt+7',
  'alt+8',
  'alt+9',
] as const satisfies readonly KeyId[]

export class SecretInput extends Input {
  override render(width: number): string[] {
    const mask = Array.from(this.getValue(), () => '•').join('')
    const cursor = this.focused ? CURSOR_MARKER : ''
    return new TruncatedText(`${mask}${cursor}`, 1, 0).render(width)
  }
}

export class OutcomeKeys implements Component {
  readonly #outcomes: readonly InteractionOutcome[]
  readonly #theme: BraidTheme
  readonly #selected: (() => InteractionOutcome | undefined) | undefined

  constructor(
    outcomes: readonly InteractionOutcome[],
    theme: BraidTheme,
    selected?: () => InteractionOutcome | undefined,
  ) {
    this.#outcomes = outcomes
    this.#theme = theme
    this.#selected = selected
  }

  invalidate(): void {}

  render(width: number): string[] {
    const maxWidth = Math.max(1, Math.floor(width))
    const rows: string[] = []
    let row = ''
    for (const [index, outcome] of this.#outcomes.entries()) {
      const key = OUTCOME_KEYS[index]
      if (key === undefined) break
      const active = outcome === this.#selected?.()
      const value = `${active ? '› ' : ''}${key} ${outcomeKeyLabel(outcome)}`
      const token = active ? this.#theme.accent(value) : value
      const separator = row === '' ? '' : ' · '
      const candidate = `${row}${separator}${token}`
      if (row !== '' && visibleWidth(candidate) > maxWidth) {
        rows.push(row)
        row = token
      } else {
        row = candidate
      }
    }
    if (row !== '' || rows.length === 0) rows.push(row)
    return rows.flatMap((line) => new TruncatedText(this.#theme.muted(line), 1, 0).render(width))
  }
}

export function outcomeForKey(
  data: string,
  outcomes: readonly InteractionOutcome[],
): InteractionOutcome | undefined {
  for (const [index, outcome] of outcomes.entries()) {
    const key = OUTCOME_KEYS[index]
    if (key !== undefined && matchesKey(data, key)) return outcome
  }
  return undefined
}

export function cancellationOutcome(interaction: InteractionView): InteractionOutcome | undefined {
  return interaction.allowedOutcomes.find((outcome) => outcome === 'cancel')
}

export function isSecretInteraction(interaction: InteractionView): boolean {
  return (
    interaction.secret ||
    interaction.answerSpec.kind === 'secret' ||
    (interaction.answerSpec.kind === 'text' && interaction.answerSpec.secret)
  )
}

export function interactionHeading(interaction: InteractionView): string {
  const kind = sanitizeTerminalText(interaction.kind).toLocaleLowerCase() || 'interaction'
  if (kind === 'plan') return 'plan review'
  return kind
}

export function runContext(interaction: InteractionView): string {
  const timeout =
    interaction.remainingMs === undefined
      ? 'timeout unknown'
      : `timeout ${Math.max(0, Math.ceil(interaction.remainingMs / 1_000))}s`
  const requester = [interaction.profileName, interaction.runner]
    .map((value) => (value === undefined ? '' : sanitizeTerminalText(value)))
    .filter((value) => value.length > 0)
    .join(' @ ')
  return [
    requester,
    `run ${shortIdentifier(interaction.runId)}`,
    ...(interaction.queuePosition > 0 ? [`request ${interaction.queuePosition + 1}`] : []),
    timeout,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function interactionSubjectComponents(
  interaction: InteractionView,
  theme: BraidTheme,
  compact: boolean,
): readonly Component[] {
  const subject = interaction.subject
  if (subject === undefined) return []
  if (isSecretInteraction(interaction))
    return [new TruncatedText(theme.muted('Secret details stay hidden.'), 1, 0)]
  const title = sanitizeTerminalText(subject.title)
  const target = subject.target ? ` · ${sanitizeTerminalText(subject.target)}` : ''
  return [
    new TruncatedText(`${theme.accent(title)}${theme.muted(target)}`, 1, 0),
    ...(compact || subject.detail === undefined
      ? []
      : [new TruncatedText(theme.muted(sanitizeTerminalText(subject.detail)), 1, 0)]),
    ...(compact || subject.preview?.[0] === undefined
      ? []
      : [new TruncatedText(sanitizeDiff(subject.preview[0]), 1, 0)]),
  ]
}

export function isPositiveOutcome(outcome: InteractionOutcome): boolean {
  return ['accept', 'once', 'session', 'persistent'].includes(outcome)
}

export function rejectionOutcome(interaction: InteractionView): InteractionOutcome | undefined {
  return interaction.allowedOutcomes.find((outcome) =>
    ['reject', 'deny', 'revise'].includes(outcome),
  )
}

export function answerOutcome(interaction: InteractionView): InteractionOutcome | undefined {
  return interaction.allowedOutcomes.find(isPositiveOutcome) ?? rejectionOutcome(interaction)
}

export function answerHelp(interaction: InteractionView): string {
  const spec = interaction.answerSpec
  if (spec.kind === 'number')
    return `answer: number${spec.minimum === undefined ? '' : ` ≥ ${spec.minimum}`}${spec.maximum === undefined ? '' : ` ≤ ${spec.maximum}`}`
  if (spec.kind === 'boolean') {
    const hasApproval = interaction.allowedOutcomes.some(isPositiveOutcome)
    const rejection = rejectionOutcome(interaction)
    if (hasApproval && rejection) return 'answer: y approve · n reject'
    if (hasApproval) return 'answer: y yes'
    if (rejection) return 'answer: n reject'
    return 'answer: esc cancel'
  }
  if (spec.kind === 'unknown') return `answer: ${sanitizeTerminalText(spec.label)}`
  if (spec.kind === 'form') return `answer: JSON · ${spec.fields.length} field(s)`
  if (spec.kind === 'secret') return 'answer: secret hidden'
  return spec.kind === 'text' && spec.secret ? 'answer: secret hidden' : 'answer: response'
}

export function interactionFooter(interaction: InteractionView, canAutomate: boolean): string {
  const parts =
    interaction.answerSpec.kind === 'boolean'
      ? [
          '↑↓ move',
          'enter confirm',
          ...(interaction.allowedOutcomes.length > 1
            ? [`1-${interaction.allowedOutcomes.length} quick select`]
            : []),
        ]
      : interaction.answerSpec.kind === 'select'
        ? ['↑↓ move', 'enter choose']
        : ['enter submit']
  if (cancellationOutcome(interaction) !== undefined) parts.push('esc cancel')
  if (canAutomate && !isSecretInteraction(interaction)) parts.push('alt+a automate')
  return parts.join(' · ')
}

function outcomeKeyLabel(outcome: InteractionOutcome): string {
  if (outcome === 'once') return 'once'
  if (outcome === 'session') return 'run'
  if (outcome === 'persistent') return 'save'
  if (outcome === 'accept') return 'approve'
  if (outcome === 'reject') return 'reject'
  if (outcome === 'deny') return 'deny'
  if (outcome === 'revise') return 'revise'
  return 'cancel'
}

function shortIdentifier(value: string): string {
  const safe = sanitizeTerminalText(value)
  return safe.length <= 20 ? safe : `${safe.slice(0, 12)}…${safe.slice(-6)}`
}
