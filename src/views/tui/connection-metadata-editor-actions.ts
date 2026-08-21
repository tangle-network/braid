import { type SelectItem, SelectList } from '@earendil-works/pi-tui'
import type { ConnectionMetadataDraft } from './connection-metadata-editor-model.js'
import type { BraidTheme } from './theme.js'

export const APPLY_DRAFT = 'apply-draft'
export const BACK_TO_FIELDS = 'back-to-fields'
export const BACK_TO_KIND = 'back-to-kind'
export const CANCEL_DRAFT = 'cancel-draft'
export const CLOSE_EDITOR = 'close-editor'

export interface ConnectionMetadataReviewListOptions {
  readonly theme: BraidTheme
  readonly busy: boolean
  readonly applied: boolean
  readonly onSelect: (value: string) => void
  readonly onCancel: () => void
}

export function createConnectionMetadataReviewList(
  options: ConnectionMetadataReviewListOptions,
): SelectList {
  const items: readonly SelectItem[] = options.applied
    ? [{ value: CLOSE_EDITOR, label: 'Close', description: '←/esc close' }]
    : [
        {
          value: APPLY_DRAFT,
          label: options.busy ? 'Saving…' : 'Continue',
          description: 'save these details',
        },
        { value: BACK_TO_FIELDS, label: '← edit fields', description: 'return to metadata' },
        { value: BACK_TO_KIND, label: '← change kind', description: 'choose another connection' },
        { value: CANCEL_DRAFT, label: 'Cancel', description: 'discard this draft' },
      ]
  const list = new SelectList([...items], Math.min(4, items.length), options.theme.select)
  list.onSelect = (item) => options.onSelect(item.value)
  list.onCancel = options.onCancel
  return list
}

export function emitConnectionMetadataDraft(
  draft: ConnectionMetadataDraft,
  onApply: (draft: ConnectionMetadataDraft) => void | Promise<void>,
  onSuccess: () => void,
  onFailure: (error: unknown) => void,
): void {
  try {
    void Promise.resolve(onApply(draft)).then(onSuccess, onFailure)
  } catch (error) {
    onFailure(error)
  }
}
