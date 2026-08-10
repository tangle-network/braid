import type { UiEvent } from './intents.js'
import type {
  AnswerSpecView,
  BraidViewModel,
  InteractionView,
  MessageView,
  SubjectView,
  TranscriptPartView,
} from './models.js'
import { sanitizeNotification, sanitizeTerminalText } from './sanitize.js'
import { semanticPayloadText } from './semantic-projection.js'

export function plainAccessibilityText(view: BraidViewModel): string {
  const lines = [
    `status: ${safeLine(view.statusText)}`,
    `conversation: ${safeLine(view.conversationTitle)}; branch: ${safeLine(view.branch)}`,
    `profile: ${safeLine(view.profileName)}; runner: ${safeLine(view.runner)}; connection: ${safeLine(view.connection)}`,
    `appearance: ${view.appearance.color}; high contrast ${view.appearance.highContrast ? 'on' : 'off'}; reduced motion ${view.appearance.reducedMotion ? 'on' : 'off'}`,
  ]

  for (const message of view.messages) lines.push(...plainMessageLines(message))
  for (const queued of view.queue ?? []) {
    lines.push(`queued message ${queued.position}: ${safeLine(queued.text)} (${queued.status})`)
  }
  for (const interaction of view.interactions) {
    lines.push(
      `interaction ${safeLine(interaction.kind)}: ${safeLine(interaction.prompt)}; response required`,
    )
    lines.push(...plainInteractionViewLines(interaction))
  }
  if (view.notice) lines.push(`notice: ${safeLine(view.notice)}`)
  if (view.storageFailure) lines.push(`storage failure: ${safeLine(view.storageFailure)}`)
  if (view.cleanupUncertain) lines.push(`cleanup uncertain: ${safeLine(view.cleanupUncertain)}`)
  return lines.join('\n')
}

export function plainEventText(view: BraidViewModel, event: UiEvent): string {
  const eventStatus = stringValue(event.payload.status) ?? view.statusText
  const header = `event ${event.sequence}: ${safeLine(event.kind)}; status: ${safeLine(eventStatus)}`
  if (event.kind === 'run.interaction') {
    return [header, ...plainInteractionEventLines(event.payload)].join('\n')
  }
  const lifecycle = plainLifecycleLines(event.kind, event.payload)
  if (lifecycle.length > 0) return [header, ...lifecycle].join('\n')
  const payload = safeLine(semanticPayloadText(event.payload))
  return `${header}${payload ? `: ${payload}` : ''}`
}

function plainInteractionEventLines(payload: Readonly<Record<string, unknown>>): string[] {
  const interaction = recordValue(payload.interaction)
  if (interaction === undefined) {
    return ['interaction details: unavailable; next action: inspect the event before responding.']
  }
  const lines: string[] = []
  pushStringLine(lines, 'interaction title', interaction.title)
  pushStringLine(lines, 'interaction kind', interaction.kind)
  const subject = recordValue(interaction.subject)
  if (subject !== undefined) {
    const subjectText = plainEventSubjectText(subject)
    if (subjectText) lines.push(`interaction subject: ${subjectText}`)
    pushStringLine(lines, 'interaction subject preview', subject.preview)
  }
  pushStringLine(lines, 'interaction body', interaction.body)
  lines.push(
    `response scopes: ${stringList(interaction.responseScopes).join(', ') || 'unspecified'}`,
  )
  lines.push(
    `allowed outcomes: ${stringList(interaction.allowedOutcomes).join(', ') || 'unspecified'}`,
  )
  lines.push(...plainEventAnswerChoiceLines(interaction.answerSpec))
  return lines
}

function plainLifecycleLines(kind: string, payload: Readonly<Record<string, unknown>>): string[] {
  const status = stringValue(payload.status)
  if (kind === 'run.detached' || status === 'detached') {
    const detail = stringValue(payload.detail)
    const cursor = stringValue(payload.cursor)
    return [
      `state: detached${detail ? `; detail: ${safeLine(detail)}` : ''}`,
      ...(cursor ? [`reconnect cursor: ${safeLine(cursor)}`] : []),
      `next action: reconnect from the last cursor${cursor ? ` (${safeLine(cursor)})` : ''}; completion is unconfirmed`,
    ]
  }
  if (kind === 'run.reconnecting' || status === 'reconnecting') {
    const cursor = stringValue(payload.cursor)
    return [
      `state: reconnecting${cursor ? ` from cursor ${safeLine(cursor)}` : ''}`,
      'next action: wait for the replay result before sending another request',
    ]
  }
  if (status === 'cancelled') {
    return [
      `state: cancelled${detailSuffix(payload)}`,
      'next action: start a new run only if the task still needs to continue',
    ]
  }
  if (status === 'failed') {
    return [
      `state: failed${detailSuffix(payload)}`,
      'next action: inspect the error before retrying',
    ]
  }
  if (status === 'expired') {
    return [
      `state: expired${detailSuffix(payload)}`,
      'next action: submit a new response or run because the response window is closed',
    ]
  }
  if (kind === 'run.unknown' || status === 'unknown') {
    return [
      `state: unknown${detailSuffix(payload)}`,
      'next action: reconcile with provider history before retrying; completion is unconfirmed',
    ]
  }
  return []
}

function plainInteractionViewLines(interaction: InteractionView): string[] {
  const lines: string[] = []
  if (!interaction.secret && interaction.subject !== undefined) {
    const subjectText = plainViewSubjectText(interaction.subject)
    if (subjectText) lines.push(`interaction subject: ${subjectText}`)
    if (interaction.subject.detail) {
      lines.push(`interaction subject detail: ${safeLine(interaction.subject.detail)}`)
    }
  }
  lines.push(
    `response scopes: ${interaction.responseScopes.map(safeLine).join(', ') || 'unspecified'}`,
  )
  lines.push(
    `interaction allowed outcomes: ${interaction.allowedOutcomes.map(safeLine).join(', ') || 'unspecified'}`,
  )
  lines.push(...plainViewAnswerChoiceLines(interaction.answerSpec, interaction.secret))
  return lines
}

function plainEventAnswerChoiceLines(value: unknown): string[] {
  const answerSpec = recordValue(value)
  const fields = answerSpec === undefined ? [] : recordValues(answerSpec.fields)
  return fields.flatMap((field) => {
    if (stringValue(field.type) !== 'select') return []
    const options = recordValues(field.options)
      .map((option) => {
        const label = stringValue(option.label)
        const optionValue = stringValue(option.value)
        if (!label && !optionValue) return undefined
        if (!label) return safeLine(optionValue ?? '')
        if (!optionValue || optionValue === label) return safeLine(label)
        return `${safeLine(label)} [${safeLine(optionValue)}]`
      })
      .filter((option): option is string => option !== undefined)
    if (options.length === 0) return []
    const label = stringValue(field.label) ?? stringValue(field.name) ?? 'select'
    return [`select choices (${safeLine(label)}): ${options.join('; ')}`]
  })
}

function plainViewAnswerChoiceLines(spec: AnswerSpecView, secret: boolean): string[] {
  if (secret || spec.kind === 'secret') return ['answer: secret hidden']
  if (spec.kind === 'select') {
    return [`answer choices: ${formatChoices(spec.options) || 'unspecified'}`]
  }
  if (spec.kind === 'form') {
    return spec.fields.flatMap((field) =>
      field.type === 'select'
        ? [
            `answer choices (${safeLine(field.label)}): ${formatChoices(field.options) || 'unspecified'}`,
          ]
        : [],
    )
  }
  return []
}

function formatChoices(
  options: readonly { readonly value: string; readonly label: string }[] | undefined,
): string {
  return (
    options
      ?.map((option) => {
        const label = safeLine(option.label)
        const value = safeLine(option.value)
        return value === label ? label : `${label} [${value}]`
      })
      .join('; ') ?? ''
  )
}

function plainEventSubjectText(subject: Readonly<Record<string, unknown>>): string {
  const type = stringValue(subject.type) ?? 'unknown'
  const detail =
    stringValue(subject.toolName) ??
    stringValue(subject.command) ??
    stringValue(subject.path) ??
    stringValue(subject.uri)
  return detail ? `${safeLine(type)}: ${safeLine(detail)}` : safeLine(type)
}

function plainViewSubjectText(subject: SubjectView): string {
  const type = safeLine(subject.type)
  const title = safeLine(subject.title)
  const target = subject.target ? `; target: ${safeLine(subject.target)}` : ''
  return `${type}: ${title}${target}`
}

function detailSuffix(payload: Readonly<Record<string, unknown>>): string {
  const detail =
    stringValue(payload.error) ?? stringValue(payload.reason) ?? stringValue(payload.detail)
  return detail ? `; detail: ${safeLine(detail)}` : ''
}

function pushStringLine(lines: string[], label: string, value: unknown): void {
  const text = stringValue(value)
  if (text !== undefined) lines.push(`${label}: ${safeLine(text)}`)
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function recordValues(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const record = recordValue(item)
    return record === undefined ? [] : [record]
  })
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map(safeLine)
}

function plainMessageLines(message: MessageView): string[] {
  const role = message.role === 'user' ? 'user message' : `${message.role} message`
  const lines = [`${role}: ${safeLine(message.text || '(empty)')}`]
  if (message.status !== 'complete') lines.push(`${role} status: ${message.status}`)
  for (const part of message.parts) {
    if (part.kind === 'text' && part.text === message.text) continue
    lines.push(...plainPartLines(role, part))
  }
  return lines
}

function plainPartLines(role: string, part: TranscriptPartView): string[] {
  const label = `${role} ${part.kind}`
  const lines = [`${label}: ${safeLine(part.text || '(empty)')}`]
  if (part.status && part.status !== 'complete') lines.push(`${label} status: ${part.status}`)
  return lines
}

function safeLine(value: string): string {
  return sanitizeNotification(sanitizeTerminalText(value))
}
