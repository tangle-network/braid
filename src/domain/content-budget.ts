import { canonicalJson } from './canonical.js'
import type { BraidRun } from './state.js'

export const MAX_RUN_CONTENT_BYTES = 512 * 1024
const TRUNCATION_MARKER = '… [truncated]'

export interface ContentReservation {
  readonly run: BraidRun
  readonly value: string
}

export function reserveText(run: BraidRun, value: string): ContentReservation {
  const remaining = Math.max(0, MAX_RUN_CONTENT_BYTES - (run.contentBytes ?? 0))
  const bounded = utf8Prefix(value, remaining)
  const bytes = Buffer.byteLength(bounded, 'utf8')
  return {
    value: bounded,
    run: {
      ...run,
      contentBytes: (run.contentBytes ?? 0) + bytes,
      ...(bounded.length !== value.length ? { contentTruncated: true } : {}),
    },
  }
}

export function reserveValue(
  run: BraidRun,
  value: unknown,
): { readonly run: BraidRun; readonly value: unknown } {
  const serialized = canonicalJson(value)
  const reservation = reserveText(run, serialized)
  if (reservation.value === serialized) return { run: reservation.run, value }
  return { run: reservation.run, value: TRUNCATION_MARKER }
}

export function utf8Prefix(value: string, bytes: number): string {
  if (bytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= bytes) return value
  let output = ''
  let used = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > bytes) break
    output += character
    used += size
  }
  return output
}
