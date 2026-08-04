import type { SelectItem } from '@earendil-works/pi-tui'
import type { BraidIntent } from '../shared/intents.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { ProfileCompatibilityResult } from './profile-compatibility.js'

export interface ProfileValidationIssue {
  readonly level: string
  readonly code: string
  readonly message: string
  readonly path?: string
}

export interface ProfileValidationReport {
  readonly ok: boolean
  readonly issues: readonly ProfileValidationIssue[]
}

export function profileItemName(item: SelectItem): string {
  return item.label.replace(/^✓\s/u, '')
}

export function selectProfileIntent(
  item: SelectItem,
  operationId: string,
  expectedRevision: number,
): BraidIntent {
  return {
    type: 'headless-command',
    command: 'select_profile',
    operationId,
    params: { ref: item.value, expectedRevision },
  }
}

export function validateProfileIntent(item: SelectItem): BraidIntent {
  return {
    type: 'headless-command',
    command: 'validate_profile',
    params: { ref: item.value },
  }
}

export function saveProfileIntent(item: SelectItem, operationId: string): BraidIntent {
  return {
    type: 'run-command',
    command: 'profile',
    operationId,
    args: ['save', item.value],
  }
}

export function profileErrorMessage(error: unknown, fallback: string): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : fallback)
}

export function readValidationReport(value: unknown): ProfileValidationReport | undefined {
  if (!isRecord(value) || !('report' in value)) return undefined
  const report = value.report
  if (!isRecord(report) || typeof report.ok !== 'boolean') return undefined
  if (!Array.isArray(report.issues)) return undefined
  return { ok: report.ok, issues: report.issues.filter(isValidationIssue) }
}

export function readProfileCompatibility(value: unknown): ProfileCompatibilityResult | undefined {
  if (!isRecord(value) || !isRecord(value.effective)) return undefined
  return value.effective
}

function isValidationIssue(value: unknown): value is ProfileValidationIssue {
  if (!isRecord(value)) return false
  return (
    typeof value.level === 'string' &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    (value.path === undefined || typeof value.path === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
