import { decodeKittyPrintable, isKeyRelease, type KeyId, matchesKey } from '@earendil-works/pi-tui'

export type GlobalKeyAction =
  | 'closeOverlay'
  | 'commandPalette'
  | 'conversationSelector'
  | 'graph'
  | 'switcher'
  | 'activity'
  | 'toggleSteer'
  | 'toggleDetails'
  | 'help'
  | 'previousBranch'
  | 'nextBranch'
  | 'exit'
  | 'clearCancelQuit'

export type BraidKeymap = Readonly<Record<GlobalKeyAction, readonly KeyId[]>>

export interface KeymapInput {
  readonly [action: string]: string | readonly string[]
}

export interface KeymapResolution {
  readonly keymap: BraidKeymap
  readonly valid: boolean
  readonly diagnostics: readonly string[]
}

const ACTION_ALIASES: Readonly<Record<string, GlobalKeyAction>> = Object.freeze({
  close: 'closeOverlay',
  closeOverlay: 'closeOverlay',
  'close-overlay': 'closeOverlay',
  palette: 'commandPalette',
  commandPalette: 'commandPalette',
  'command-palette': 'commandPalette',
  conversations: 'conversationSelector',
  conversationSelector: 'conversationSelector',
  'conversation-selector': 'conversationSelector',
  graph: 'graph',
  switcher: 'switcher',
  activity: 'activity',
  toggleSteer: 'toggleSteer',
  'toggle-steer': 'toggleSteer',
  toggleDetails: 'toggleDetails',
  'toggle-details': 'toggleDetails',
  help: 'help',
  previousBranch: 'previousBranch',
  'previous-branch': 'previousBranch',
  nextBranch: 'nextBranch',
  'next-branch': 'nextBranch',
  exit: 'exit',
  clearCancelQuit: 'clearCancelQuit',
  'clear-cancel-quit': 'clearCancelQuit',
})

const DEFAULT_KEYMAP: BraidKeymap = Object.freeze({
  closeOverlay: Object.freeze(['escape', 'left'] as KeyId[]),
  commandPalette: Object.freeze(['ctrl+p'] as KeyId[]),
  conversationSelector: Object.freeze(['ctrl+o'] as KeyId[]),
  graph: Object.freeze(['ctrl+g'] as KeyId[]),
  switcher: Object.freeze(['ctrl+k'] as KeyId[]),
  activity: Object.freeze(['f2'] as KeyId[]),
  toggleSteer: Object.freeze(['alt+s'] as KeyId[]),
  toggleDetails: Object.freeze(['ctrl+e'] as KeyId[]),
  help: Object.freeze(['?'] as KeyId[]),
  previousBranch: Object.freeze(['alt+up'] as KeyId[]),
  nextBranch: Object.freeze(['alt+down'] as KeyId[]),
  exit: Object.freeze(['ctrl+d'] as KeyId[]),
  clearCancelQuit: Object.freeze(['ctrl+c'] as KeyId[]),
})

const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'super'])
const BASE_KEYS = new Set([
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  '`',
  '-',
  '=',
  '[',
  ']',
  '\\',
  ';',
  "'",
  ',',
  '.',
  '/',
  '!',
  '@',
  '#',
  '$',
  '%',
  '^',
  '&',
  '*',
  '(',
  ')',
  '_',
  '+',
  '|',
  '~',
  '{',
  '}',
  ':',
  '<',
  '>',
  '?',
  'escape',
  'enter',
  'return',
  'tab',
  'space',
  'backspace',
  'delete',
  'insert',
  'clear',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
])

const ACTIONS = Object.keys(DEFAULT_KEYMAP) as GlobalKeyAction[]

export function defaultKeymap(): BraidKeymap {
  return DEFAULT_KEYMAP
}

export function resolveKeymap(raw = process.env.BRAID_KEYMAP): KeymapResolution {
  if (raw === undefined || raw.trim() === '') {
    return Object.freeze({ keymap: DEFAULT_KEYMAP, valid: true, diagnostics: Object.freeze([]) })
  }

  const diagnostics: string[] = []
  const entries = parseEntries(raw, diagnostics)
  const candidate: Record<GlobalKeyAction, readonly KeyId[]> = { ...DEFAULT_KEYMAP }
  const configuredActions = new Set<GlobalKeyAction>()

  for (const [rawAction, rawKeys] of entries) {
    const action = ACTION_ALIASES[rawAction]
    if (action === undefined) {
      diagnostics.push(`Unknown key mapping action '${rawAction}'`)
      continue
    }
    if (configuredActions.has(action)) {
      diagnostics.push(`Key mapping action '${rawAction}' is configured more than once`)
      continue
    }
    configuredActions.add(action)
    const keys = Array.isArray(rawKeys) ? rawKeys : [rawKeys]
    const normalized = keys.map((key) => normalizeKeyId(key, diagnostics, action))
    if (normalized.length > 0 && normalized.every((key): key is KeyId => key !== undefined)) {
      candidate[action] = Object.freeze(normalized)
    }
  }

  const ownership = new Map<string, GlobalKeyAction>()
  for (const action of ACTIONS) {
    for (const key of candidate[action]) {
      const canonical = canonicalKeyId(key)
      const previous = ownership.get(canonical)
      if (previous !== undefined && previous !== action) {
        diagnostics.push(
          `Key '${key}' is assigned to both ${previous} and ${action}; the mapping was rejected`,
        )
      } else {
        ownership.set(canonical, action)
      }
    }
  }

  if (diagnostics.length > 0) {
    return Object.freeze({
      keymap: DEFAULT_KEYMAP,
      valid: false,
      diagnostics: Object.freeze(diagnostics),
    })
  }

  return Object.freeze({
    keymap: freezeKeymap(candidate),
    valid: true,
    diagnostics: Object.freeze([]),
  })
}

export function matchesKeyAction(
  data: string,
  keymap: BraidKeymap,
  action: GlobalKeyAction,
): boolean {
  if (isKeyRelease(data)) return false
  return keymap[action].some((key) => matchesKey(data, key))
}

export function isTextInputSequence(data: string): boolean {
  return (
    data.includes('\u001b[200~') ||
    data.includes('\u001b[201~') ||
    decodeKittyPrintable(data) !== undefined
  )
}

function parseEntries(
  raw: string,
  diagnostics: string[],
): readonly (readonly [string, string | readonly string[]])[] {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      const entries: Array<readonly [string, string | readonly string[]]> = []
      for (const [action, keys] of Object.entries(parsed)) {
        if (typeof keys === 'string') {
          entries.push([action, keys] as const)
          continue
        }
        if (Array.isArray(keys) && keys.every((key) => typeof key === 'string')) {
          entries.push([action, keys] as const)
          continue
        }
        diagnostics.push(`Key mapping '${action}' must be a key or an array of keys`)
      }
      return entries
    } catch {
      diagnostics.push('BRAID_KEYMAP must be a mapping object or action=key entries')
      return []
    }
  }

  return trimmed.split(',').flatMap((entry) => {
    const separator = entry.indexOf('=')
    if (separator <= 0 || separator === entry.length - 1) {
      diagnostics.push(`Invalid key mapping '${entry}'`)
      return []
    }
    const action = entry.slice(0, separator).trim()
    const keys = entry
      .slice(separator + 1)
      .split('|')
      .map((key) => key.trim())
      .filter(Boolean)
    if (keys.length === 0) {
      diagnostics.push(`Key mapping '${action}' has no keys`)
      return []
    }
    return [[action, keys] as const]
  })
}

function normalizeKeyId(
  value: string,
  diagnostics: string[],
  action: GlobalKeyAction,
): KeyId | undefined {
  const normalized = value.trim().toLowerCase()
  const parts = normalized.split('+')
  const base = parts.pop()
  if (!base || !BASE_KEYS.has(base) || parts.some((part) => !MODIFIERS.has(part))) {
    diagnostics.push(`Invalid key '${value}' for ${action}`)
    return undefined
  }
  if (new Set(parts).size !== parts.length) {
    diagnostics.push(`Key '${value}' repeats a modifier for ${action}`)
    return undefined
  }
  return [...parts.sort(), base].join('+') as KeyId
}

function canonicalKeyId(key: KeyId): string {
  const parts = key.split('+')
  const base = parts.pop() ?? ''
  return [...parts.sort(), base].join('+')
}

function freezeKeymap(candidate: Record<GlobalKeyAction, readonly KeyId[]>): BraidKeymap {
  return Object.freeze(
    Object.fromEntries(
      ACTIONS.map((action) => [action, Object.freeze([...candidate[action]])]),
    ) as Record<GlobalKeyAction, readonly KeyId[]>,
  )
}
