import {
  type Component,
  decodeKittyPrintable,
  type KeyId,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { InteractionResponseValue } from '../shared/intents.js'
import type { InteractionOutcome } from '../shared/models.js'
import type { BraidTheme } from './theme.js'

interface DecisionOption {
  readonly outcome: InteractionOutcome
  readonly label: string
  readonly description: string
}

export interface InteractionDecisionListOptions {
  readonly outcomes: readonly InteractionOutcome[]
  readonly selected?: InteractionOutcome
  readonly theme: BraidTheme
  readonly onSelectionChange: (outcome: InteractionOutcome) => void
  readonly onConfirm: (outcome: InteractionOutcome) => void
}

/** Presents boolean approval outcomes as one navigable action list. */
export class InteractionDecisionList implements Component {
  readonly #options: readonly DecisionOption[]
  readonly #theme: BraidTheme
  readonly #onSelectionChange: InteractionDecisionListOptions['onSelectionChange']
  readonly #onConfirm: InteractionDecisionListOptions['onConfirm']
  #selectedIndex: number

  constructor(options: InteractionDecisionListOptions) {
    this.#options = options.outcomes.map(optionFor)
    this.#theme = options.theme
    this.#onSelectionChange = options.onSelectionChange
    this.#onConfirm = options.onConfirm
    const selected = this.#options.findIndex((option) => option.outcome === options.selected)
    this.#selectedIndex = selected < 0 ? 0 : selected
  }

  invalidate(): void {}

  selectedOutcome(): InteractionOutcome | undefined {
    return this.#options[this.#selectedIndex]?.outcome
  }

  handleInput(data: string): boolean {
    if (this.#options.length === 0) return false
    if (matchesKey(data, 'up')) {
      this.#move(-1)
      return true
    }
    if (matchesKey(data, 'down')) {
      this.#move(1)
      return true
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      this.#confirm(this.#selectedIndex)
      return true
    }
    const index = decisionIndex(data, this.#options.length)
    if (index !== undefined) {
      const selected = this.#options[index]
      if (selected === undefined) return false
      this.#selectedIndex = index
      this.#onSelectionChange(selected.outcome)
      this.#confirm(index)
      return true
    }
    return false
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    return this.#options.flatMap((option, index) => {
      const selected = index === this.#selectedIndex
      const pointer = selected ? this.#theme.accent('›') : ' '
      const label = selected ? this.#theme.accent(option.label) : this.#theme.text(option.label)
      const line = truncateToWidth(` ${pointer} ${index + 1}. ${label}`, safeWidth, '…', true)
      if (!selected) return [line]
      const description = wrapTextWithAnsi(
        this.#theme.muted(option.description),
        Math.max(1, safeWidth - 6),
      ).map((value) => truncateToWidth(`      ${value}`, safeWidth, '…', true))
      return [line, ...description]
    })
  }

  #move(delta: -1 | 1): void {
    this.#selectedIndex =
      (this.#selectedIndex + delta + this.#options.length) % this.#options.length
    const selected = this.#options[this.#selectedIndex]
    if (selected !== undefined) this.#onSelectionChange(selected.outcome)
  }

  #confirm(index: number): void {
    const selected = this.#options[index]
    if (selected !== undefined) this.#onConfirm(selected.outcome)
  }
}

export function booleanDecisionResponse(
  data: string,
  outcomes: readonly InteractionOutcome[],
): InteractionResponseValue | undefined {
  const approval = outcomes.find(isPositiveOutcome)
  const rejection = outcomes.find((outcome) => ['reject', 'deny', 'revise'].includes(outcome))
  if ((data === 'y' || data === 'Y') && approval !== undefined) {
    return { outcome: approval, value: true }
  }
  if ((data === 'n' || data === 'N') && (rejection !== undefined || approval !== undefined)) {
    if (rejection !== undefined) return { outcome: rejection }
    if (approval !== undefined) return { outcome: approval, value: false }
  }
  return undefined
}

function optionFor(outcome: InteractionOutcome): DecisionOption {
  switch (outcome) {
    case 'once':
      return { outcome, label: 'Allow once', description: 'Only this request' }
    case 'session':
      return { outcome, label: 'Allow for this run', description: 'Reuse until the run ends' }
    case 'persistent':
      return { outcome, label: 'Always allow', description: 'Reuse for future matching requests' }
    case 'accept':
      return { outcome, label: 'Approve', description: 'Continue this request' }
    case 'revise':
      return { outcome, label: 'Request changes', description: 'Return the request for revision' }
    case 'reject':
      return { outcome, label: 'Reject', description: 'Continue without approval' }
    case 'deny':
      return { outcome, label: 'Deny', description: 'Do not allow this request' }
    case 'cancel':
      return { outcome, label: 'Cancel', description: 'Stop this request' }
  }
}

function decisionIndex(data: string, count: number): number | undefined {
  const printable = decodeKittyPrintable(data) ?? data
  for (let index = 0; index < Math.min(9, count); index += 1) {
    if (printable === String(index + 1) || matchesKey(data, `alt+${index + 1}` as KeyId)) {
      return index
    }
  }
  return undefined
}

function isPositiveOutcome(outcome: InteractionOutcome): boolean {
  return ['accept', 'once', 'session', 'persistent'].includes(outcome)
}
