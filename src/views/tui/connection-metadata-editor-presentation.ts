import type { SelectItem } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type {
  ConnectionMetadataDraft,
  ConnectionMetadataFormValues,
  ConnectionMetadataKind,
} from './connection-metadata-editor-model.js'

const DEFAULT_ENDPOINTS: Readonly<Record<ConnectionMetadataKind, string>> = Object.freeze({
  'cli-bridge': 'http://127.0.0.1:3344',
  'tangle-inference': 'https://router.tangle.tools',
  'tangle-sandbox': 'https://sandbox.tangle.tools',
})

const DEFAULT_NAMES: Readonly<Record<ConnectionMetadataKind, string>> = Object.freeze({
  'cli-bridge': 'Local CLI Bridge',
  'tangle-inference': 'Tangle Inference',
  'tangle-sandbox': 'Tangle Sandbox',
})

const KIND_ITEMS: readonly SelectItem[] = Object.freeze([
  { value: 'cli-bridge', label: 'CLI Bridge', description: 'local runner endpoint' },
  {
    value: 'tangle-inference',
    label: 'Tangle inference',
    description: 'remote model routing endpoint',
  },
  {
    value: 'tangle-sandbox',
    label: 'Tangle sandbox',
    description: 'remote workspace execution endpoint',
  },
])

export type EditableConnectionMetadataField = 'name' | 'endpoint' | 'account' | 'region'

export function connectionMetadataKindItems(): readonly SelectItem[] {
  return KIND_ITEMS
}

export function connectionMetadataKindLabel(kind: ConnectionMetadataKind): string {
  return KIND_ITEMS.find((item) => item.value === kind)?.label ?? kind
}

export function connectionMetadataFormDefaults(
  kind: ConnectionMetadataKind,
): ConnectionMetadataFormValues {
  return Object.freeze({
    kind,
    name: DEFAULT_NAMES[kind],
    endpoint: DEFAULT_ENDPOINTS[kind],
    region: '',
    account: '',
  })
}

export function connectionMetadataFormFromDraft(
  draft?: Partial<ConnectionMetadataDraft>,
): ConnectionMetadataFormValues {
  const kind = isKind(draft?.kind) ? draft.kind : 'cli-bridge'
  const defaults = connectionMetadataFormDefaults(kind)
  return Object.freeze({
    kind,
    name: draftText(draft?.name, defaults.name),
    endpoint: draftText(draft?.endpoint, defaults.endpoint),
    region: draftText(draft?.region, defaults.region),
    account: draftText(draft?.account, defaults.account),
  })
}

export function connectionMetadataFieldKeys(
  kind: ConnectionMetadataKind,
): readonly EditableConnectionMetadataField[] {
  return kind === 'cli-bridge' ? ['name', 'endpoint'] : ['name', 'endpoint', 'account', 'region']
}

export function connectionMetadataFieldLabel(field: EditableConnectionMetadataField): string {
  switch (field) {
    case 'name':
      return 'display name'
    case 'endpoint':
      return 'HTTP(S) endpoint'
    case 'account':
      return 'account / team (optional)'
    case 'region':
      return 'region (optional)'
  }
}

export function connectionMetadataSummary(draft: ConnectionMetadataDraft): readonly string[] {
  return [
    `kind ${connectionMetadataKindLabel(draft.kind)}`,
    `name ${draft.name}`,
    `endpoint ${draft.endpoint}`,
    ...(draft.account === undefined ? [] : [`account ${draft.account}`]),
    ...(draft.region === undefined ? [] : [`region ${draft.region}`]),
    'credentials entered separately · values never accepted here',
  ]
}

function isKind(value: unknown): value is ConnectionMetadataKind {
  return value === 'cli-bridge' || value === 'tangle-inference' || value === 'tangle-sandbox'
}

function draftText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? sanitizeTerminalText(value) : fallback
}
