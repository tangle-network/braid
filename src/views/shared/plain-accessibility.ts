import type { UiEvent } from './intents.js'
import type { BraidViewModel, MessageView, TranscriptPartView } from './models.js'
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
    if (interaction.allowedOutcomes.length > 0) {
      lines.push(`interaction choices: ${interaction.allowedOutcomes.join(', ')}`)
    }
  }
  if (view.notice) lines.push(`notice: ${safeLine(view.notice)}`)
  if (view.storageFailure) lines.push(`storage failure: ${safeLine(view.storageFailure)}`)
  if (view.cleanupUncertain) lines.push(`cleanup uncertain: ${safeLine(view.cleanupUncertain)}`)
  return lines.join('\n')
}

export function plainEventText(view: BraidViewModel, event: UiEvent): string {
  const payload = safeLine(semanticPayloadText(event.payload))
  return `event ${event.sequence}: ${safeLine(event.kind)}${payload ? `: ${payload}` : ''}; status: ${safeLine(view.statusText)}`
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
