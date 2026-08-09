import {
  type Component,
  type Input,
  type SelectList,
  Spacer,
  Text,
  truncateToWidth,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type {
  ConnectionMetadataDraft,
  ConnectionMetadataFormValues,
} from './connection-metadata-editor-model.js'
import {
  connectionMetadataFieldKeys,
  connectionMetadataFieldLabel,
  connectionMetadataKindLabel,
  connectionMetadataSummary,
  type EditableConnectionMetadataField,
} from './connection-metadata-editor-presentation.js'
import type { BraidTheme } from './theme.js'

export type ConnectionMetadataEditorStage = 'kind' | 'fields' | 'review'

export interface ConnectionMetadataEditorRenderState {
  readonly theme: BraidTheme
  readonly stage: ConnectionMetadataEditorStage
  readonly form: ConnectionMetadataFormValues
  readonly kindList: SelectList
  readonly inputs: ReadonlyMap<EditableConnectionMetadataField, Input>
  readonly reviewDraft?: ConnectionMetadataDraft
  readonly reviewList?: SelectList
  readonly error?: string
  readonly busy: boolean
  readonly applied: boolean
}

export function connectionMetadataEditorChildren(
  state: ConnectionMetadataEditorRenderState,
): readonly Component[] {
  if (state.stage === 'kind') return kindChildren(state)
  if (state.stage === 'fields') return fieldChildren(state)
  return reviewChildren(state)
}

function kindChildren(state: ConnectionMetadataEditorRenderState): readonly Component[] {
  return [
    new Text(state.theme.brand('connection metadata'), 1, 0),
    new Text(
      state.theme.muted(
        'Choose where requests go. This editor collects metadata only; credentials are entered separately.',
      ),
      1,
      0,
    ),
    new Spacer(1),
    new Text(state.theme.accent('connection kind'), 1, 0),
    state.kindList,
    new Spacer(1),
    new Text(state.theme.muted('↑↓ choose · enter next · esc cancel'), 1, 0),
  ]
}

function fieldChildren(state: ConnectionMetadataEditorRenderState): readonly Component[] {
  const children: Component[] = [
    new Text(state.theme.brand(`${connectionMetadataKindLabel(state.form.kind)} metadata`), 1, 0),
    new Text(state.theme.muted('Metadata only · credential values are never accepted here'), 1, 0),
  ]
  if (state.error !== undefined) {
    children.push(new Text(state.theme.danger(sanitizeTerminalText(state.error)), 1, 0))
  }
  children.push(new Spacer(1))
  for (const field of connectionMetadataFieldKeys(state.form.kind)) {
    children.push(new Text(state.theme.accent(connectionMetadataFieldLabel(field)), 1, 0))
    const input = state.inputs.get(field)
    if (input !== undefined) children.push(input)
  }
  children.push(
    new Spacer(1),
    new Text(state.theme.muted('tab / enter next · shift+tab back · esc cancel'), 1, 0),
  )
  return children
}

function reviewChildren(state: ConnectionMetadataEditorRenderState): readonly Component[] {
  const children: Component[] = [
    new Text(state.theme.brand(state.applied ? 'connection saved' : 'review connection'), 1, 0),
  ]
  if (state.error !== undefined) {
    children.push(new Text(state.theme.danger(sanitizeTerminalText(state.error)), 1, 0))
  }
  if (state.reviewDraft !== undefined) {
    children.push(new MetadataReviewSummary(state.theme, state.reviewDraft))
  }
  if (state.reviewList !== undefined) children.push(state.reviewList)
  children.push(
    new Text(
      state.theme.muted(
        state.applied
          ? 'enter close · esc close'
          : state.busy
            ? 'saving…'
            : '↑↓ choose · enter continue / back · esc cancel',
      ),
      1,
      0,
    ),
  )
  return children
}

class MetadataReviewSummary implements Component {
  readonly #theme: BraidTheme
  readonly #wide: Text
  readonly #compact: readonly string[]

  constructor(theme: BraidTheme, draft: ConnectionMetadataDraft) {
    this.#theme = theme
    const lines = connectionMetadataSummary(draft).map(sanitizeTerminalText)
    this.#wide = new Text(theme.muted(lines.join('\n')), 1, 0)
    this.#compact = [
      `${connectionMetadataKindLabel(draft.kind)} · ${sanitizeTerminalText(draft.name)}`,
      `endpoint ${sanitizeTerminalText(draft.endpoint)}`,
      ...(draft.account === undefined ? [] : [`account ${sanitizeTerminalText(draft.account)}`]),
      ...(draft.region === undefined ? [] : [`region ${sanitizeTerminalText(draft.region)}`]),
      'credentials separate · no values accepted',
    ]
  }

  invalidate(): void {
    this.#wide.invalidate()
  }

  render(width: number): string[] {
    if (width > 44) return this.#wide.render(width)
    return this.#compact.map((line) =>
      this.#theme.muted(truncateToWidth(sanitizeTerminalText(line), Math.max(1, width - 2), '…')),
    )
  }
}
