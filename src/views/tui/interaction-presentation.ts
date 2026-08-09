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

export class MutableTruncatedLine implements Component {
  #value = ''

  setValue(value: string): void {
    this.#value = value
  }

  invalidate(): void {}

  render(width: number): string[] {
    return new TruncatedText(this.#value, 1, 0).render(width)
  }
}

export class OutcomeKeys implements Component {
  readonly #outcomes: readonly InteractionOutcome[]
  readonly #theme: BraidTheme

  constructor(outcomes: readonly InteractionOutcome[], theme: BraidTheme) {
    this.#outcomes = outcomes
    this.#theme = theme
  }

  invalidate(): void {}

  render(width: number): string[] {
    const maxWidth = Math.max(1, Math.floor(width))
    const rows: string[] = []
    let row = 'keys:'
    for (const [index, outcome] of this.#outcomes.entries()) {
      const key = OUTCOME_KEYS[index]
      if (key === undefined) break
      const token = `${key} ${outcomeKeyLabel(outcome)}`
      const separator = row === 'keys:' ? ' ' : ' · '
      const candidate = `${row}${separator}${token}`
      if (row !== 'keys:' && visibleWidth(candidate) > maxWidth) {
        rows.push(row)
        row = token
      } else {
        row = candidate
      }
    }
    if (row !== 'keys:' || rows.length === 0) rows.push(row)
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

export function isSecretInteraction(interaction: InteractionView): boolean {
  return (
    interaction.secret ||
    interaction.answerSpec.kind === 'secret' ||
    (interaction.answerSpec.kind === 'text' && interaction.answerSpec.secret)
  )
}

export function interactionHeading(interaction: InteractionView): string {
  const kind = sanitizeTerminalText(interaction.kind).toLocaleLowerCase() || 'interaction'
  if (kind === 'permission' || kind === 'plan') return `${kind} · approve or reject`
  if (kind === 'question') return `${kind} · answer required`
  return `${kind} · response required`
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
  return `run: ${sanitizeTerminalText(interaction.runId)}${requester ? ` · ${requester}` : ''} · queue ${interaction.queuePosition + 1} · ${timeout}`
}

export function interactionSubjectComponents(
  interaction: InteractionView,
  theme: BraidTheme,
  compact: boolean,
): readonly Component[] {
  const subject = interaction.subject
  if (subject === undefined) return []
  if (isSecretInteraction(interaction))
    return [new TruncatedText(theme.muted('request: secret input · details hidden'), 1, 0)]
  const title = sanitizeTerminalText(subject.title)
  const target = subject.target ? ` · ${sanitizeTerminalText(subject.target)}` : ''
  return [
    new TruncatedText(theme.muted(`request: ${title}${target}`), 1, 0),
    ...(compact || subject.detail === undefined
      ? []
      : [new TruncatedText(`detail: ${sanitizeTerminalText(subject.detail)}`, 1, 0)]),
    ...(compact || subject.preview?.[0] === undefined
      ? []
      : [new TruncatedText(sanitizeDiff(subject.preview[0]), 1, 0)]),
  ]
}

export function consequence(
  interaction: InteractionView,
  selectedOutcome?: InteractionOutcome,
): string {
  const outcomes =
    selectedOutcome !== undefined && isPositiveOutcome(selectedOutcome)
      ? [
          selectedOutcome,
          ...interaction.allowedOutcomes.filter((outcome) => outcome !== selectedOutcome),
        ]
      : interaction.allowedOutcomes
  const choices = outcomes.map((outcome) => outcomeConsequenceLabel(outcome))
  return choices.length > 0 ? `will: ${choices.join(' · ')}` : 'will: choose a response'
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
  if (spec.kind === 'boolean')
    return rejectionOutcome(interaction) ? 'answer: y approve · n reject' : 'answer: y yes · n no'
  if (spec.kind === 'unknown') return `answer: ${sanitizeTerminalText(spec.label)}`
  if (spec.kind === 'form') return `answer: JSON · ${spec.fields.length} field(s)`
  if (spec.kind === 'secret') return 'answer: secret hidden'
  return spec.kind === 'text' && spec.secret ? 'answer: secret hidden' : 'answer: response'
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

function outcomeConsequenceLabel(outcome: InteractionOutcome): string {
  if (outcome === 'once') return 'approve once'
  if (outcome === 'session') return 'approve run'
  if (outcome === 'persistent') return 'save approval'
  if (outcome === 'accept') return 'approve'
  if (outcome === 'reject') return 'reject'
  if (outcome === 'deny') return 'deny'
  if (outcome === 'revise') return 'revise'
  return 'cancel'
}
