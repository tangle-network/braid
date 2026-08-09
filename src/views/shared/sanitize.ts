import {
  isSensitiveFieldName,
  redactSensitiveText,
  redactSensitiveUrls,
  redactStructuredValue,
} from '../../domain/redaction.js'

export type UntrustedSurface =
  | 'text'
  | 'markdown'
  | 'diff'
  | 'link'
  | 'clipboard'
  | 'title'
  | 'notification'
  | 'image'

export interface SanitizedValue {
  readonly value: string
  readonly removedControls: boolean
  readonly removedBidi: boolean
}

export { isSensitiveFieldName, redactSensitiveText, redactSensitiveUrls, redactStructuredValue }

export const MAX_RENDERED_TEXT_CHARS = 200_000
export const MAX_RENDERED_TEXT_LINES = 4_000

export function sanitizeTerminalText(input: string): string {
  return redactSensitiveText(input)
}

/** Bound text after terminal sanitization, before any renderer parses it. */
export function boundVisibleText(input: string): string {
  let value = sanitizeTerminalText(input)
  const lines = value.split('\n')
  if (lines.length > MAX_RENDERED_TEXT_LINES) {
    value = `…\n${lines.slice(-MAX_RENDERED_TEXT_LINES).join('\n')}`
  }
  if (value.length > MAX_RENDERED_TEXT_CHARS) {
    value = `…\n${Array.from(value)
      .slice(-(MAX_RENDERED_TEXT_CHARS - 2))
      .join('')}`
  }
  return value
}

export function sanitizeForSurface(input: string, _surface: UntrustedSurface): SanitizedValue {
  const value = redactSensitiveText(input)
  return {
    value,
    removedControls: value !== input,
    removedBidi: /\p{Bidi_Control}/u.test(input),
  }
}

export function sanitizeUrl(input: string): string | undefined {
  const value = sanitizeTerminalText(input).trim()
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    if (url.username || url.password) return undefined
    for (const key of url.searchParams.keys()) if (isSensitiveFieldName(key)) return undefined
    const fragment = url.hash.slice(1)
    if (fragment) {
      const fragmentParameters = new URLSearchParams(fragment)
      for (const key of fragmentParameters.keys()) if (isSensitiveFieldName(key)) return undefined
    }
    return url.toString()
  } catch {
    return undefined
  }
}

function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('')
}

export function sanitizeMarkdown(input: string): string {
  return redactSensitiveUrls(sanitizeForSurface(input, 'markdown').value)
}

export function sanitizeDiff(input: string): string {
  return sanitizeForSurface(input, 'diff').value
}

export function sanitizeClipboardText(input: string): string {
  return sanitizeForSurface(input, 'clipboard').value
}

export function sanitizeTitle(input: string): string {
  const value = sanitizeForSurface(input, 'title')
    .value.replace(/[\n\t]+/gu, ' ')
    .trim()
  return truncateCodePoints(value, 120)
}

export function sanitizeNotification(input: string): string {
  const value = sanitizeForSurface(input, 'notification')
    .value.replace(/[\n\t]+/gu, ' ')
    .trim()
  return truncateCodePoints(value, 512)
}

export function sanitizeImageAlt(input: string): string {
  const value = sanitizeForSurface(input, 'image')
    .value.replace(/[\n\t]+/gu, ' ')
    .trim()
  return truncateCodePoints(value, 512)
}
