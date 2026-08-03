import type { AgentProfile } from '@tangle-network/agent-interface'

const BIDI_CONTROLS = /\p{Bidi_Control}/gu
// biome-ignore lint/complexity/useRegexLiterals: a literal with these delimiters is rejected as containing controls
const WEB_URL = new RegExp(String.raw`https?:\/\/[^\s\u0000-\u0020\u007f<>"'\u001b]+`, 'giu')
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/giu
const SENSITIVE_NAME =
  /(?:password|passwd|passphrase|token|secret|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|signature|session[_-]?id|jwt|auth[_-]?code|bearer|nonce|answer|challenge|headers?|cookies?|query)/iu
const STRUCTURALLY_SECRET = /(?:mcp|attestation|confidential(?:ity)?|profile|credentials?)/iu

function stripTerminalControls(input: string): string {
  let output = ''
  let state: 'normal' | 'escape' | 'csi' | 'osc' | 'string' | 'osc-escape' | 'string-escape' =
    'normal'

  for (const character of input) {
    const code = character.codePointAt(0) ?? 0
    switch (state) {
      case 'normal':
        if (character === '\u001b') state = 'escape'
        else if (character === '\u009b') state = 'csi'
        else if (character === '\u009d') state = 'osc'
        else if (
          character === '\u0090' ||
          character === '\u0098' ||
          character === '\u009e' ||
          character === '\u009f'
        )
          state = 'string'
        else if (character === '\u009c') {
          // String terminator without an open string is still untrusted control data.
        } else if (character === '\n' || character === '\t') output += character
        else if ((code >= 0x20 && code < 0x7f) || code > 0x9f) output += character
        break
      case 'escape':
        if (character === '[') state = 'csi'
        else if (character === ']') state = 'osc'
        else if (character === 'P' || character === '^' || character === '_') state = 'string'
        else state = 'normal'
        break
      case 'csi':
        if (character === '\u009c' || (code >= 0x40 && code <= 0x7e)) state = 'normal'
        break
      case 'osc':
        if (character === '\u0007' || character === '\u009c') state = 'normal'
        else if (character === '\u001b') state = 'osc-escape'
        break
      case 'string':
        if (character === '\u009c') state = 'normal'
        else if (character === '\u001b') state = 'string-escape'
        break
      case 'osc-escape':
        state = character === '\\' ? 'normal' : 'osc'
        break
      case 'string-escape':
        state = character === '\\' ? 'normal' : 'string'
        break
      default: {
        const exhaustive: never = state
        return exhaustive
      }
    }
  }

  return output.replace(BIDI_CONTROLS, '')
}

function safeUrl(candidate: string): string | undefined {
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    if (url.username || url.password) return undefined
    for (const key of url.searchParams.keys()) if (SENSITIVE_NAME.test(key)) return undefined
    const fragment = url.hash.slice(1)
    if (fragment) {
      const fragmentParameters = new URLSearchParams(fragment)
      for (const key of fragmentParameters.keys()) if (SENSITIVE_NAME.test(key)) return undefined
    }
    return url.toString()
  } catch {
    return undefined
  }
}

export function redactSensitiveUrls(input: string): string {
  return input.replace(WEB_URL, (candidate) => {
    let url = candidate
    let suffix = ''
    while (/[),.;!?\]}]$/u.test(url)) {
      suffix = `${url.at(-1)}${suffix}`
      url = url.slice(0, -1)
    }
    return safeUrl(url) ? candidate : `[redacted link]${suffix}`
  })
}

export function redactSensitiveText(input: string): string {
  return redactSensitiveUrls(stripTerminalControls(input)).replace(
    BEARER_VALUE,
    '[redacted bearer]',
  )
}

export function isSensitiveFieldName(input: string): boolean {
  return SENSITIVE_NAME.test(input) || STRUCTURALLY_SECRET.test(input)
}

export function redactStructuredValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveFieldName(key)) return '[redacted]'
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item))

  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactStructuredValue(child, childKey),
    ]),
  )
}

export function redactProfile(profile: Readonly<AgentProfile>): Readonly<AgentProfile> {
  return redactStructuredValue(profile) as Readonly<AgentProfile>
}

export function redactProviderError(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(error.message)
  if (typeof error === 'string') return redactSensitiveText(error)
  return 'Provider error'
}

/**
 * Sanitizes every string a journal event carries without collapsing structure.
 *
 * Braid builds canonical domain records itself, so blanking a value because its
 * key reads as sensitive would destroy legitimate records such as
 * `profile.registered` or `credential.reference.created`, both of which already
 * carry references and digests rather than secret material. Provider-authored
 * text is the untrusted part, and it is always a string, so control sequences,
 * bidi overrides, credential URLs, and bearer values are stripped in place.
 */
export function redactBraidEvent<T>(event: T): T {
  return sanitizeStrings(event) as T
}

function sanitizeStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sanitizeStrings)
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, sanitizeStrings(child)]),
  )
}
