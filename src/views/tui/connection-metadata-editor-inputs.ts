import { getKeybindings, Input, matchesKey } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type {
  ConnectionMetadataFormValues,
  ConnectionMetadataKind,
} from './connection-metadata-editor-model.js'
import {
  connectionMetadataFieldKeys,
  type EditableConnectionMetadataField,
} from './connection-metadata-editor-presentation.js'

export type ConnectionMetadataInputAction = 'cancel' | 'back' | 'next'

export interface ConnectionMetadataFieldInputHandlers {
  readonly kind: ConnectionMetadataKind
  readonly fieldIndex: number
  readonly inputs: ReadonlyMap<EditableConnectionMetadataField, Input>
  readonly onAction: (action: ConnectionMetadataInputAction) => void
  readonly onValue: (field: EditableConnectionMetadataField, value: string) => void
}

export function handleConnectionMetadataFieldInput(
  data: string,
  handlers: ConnectionMetadataFieldInputHandlers,
): void {
  const keybindings = getKeybindings()
  if (keybindings.matches(data, 'tui.select.cancel')) {
    handlers.onAction('cancel')
    return
  }
  if (matchesKey(data, 'shift+tab')) {
    handlers.onAction('back')
    return
  }
  if (keybindings.matches(data, 'tui.input.tab') || keybindings.matches(data, 'tui.input.submit')) {
    handlers.onAction('next')
    return
  }
  const field = connectionMetadataFieldKeys(handlers.kind)[handlers.fieldIndex]
  const input = field === undefined ? undefined : handlers.inputs.get(field)
  if (field === undefined || input === undefined) return
  input.handleInput(data)
  const value = sanitizeTerminalText(input.getValue())
  if (value !== input.getValue()) input.setValue(value)
  handlers.onValue(field, value)
}

export function buildConnectionMetadataInputs(
  form: ConnectionMetadataFormValues,
  inputs: Map<EditableConnectionMetadataField, Input>,
): void {
  inputs.clear()
  for (const field of connectionMetadataFieldKeys(form.kind)) {
    const input = new Input()
    input.setValue(form[field])
    inputs.set(field, input)
  }
}

export function captureConnectionMetadataInput(
  form: ConnectionMetadataFormValues,
  inputs: ReadonlyMap<EditableConnectionMetadataField, Input>,
  fieldIndex: number,
): ConnectionMetadataFormValues {
  const field = connectionMetadataFieldKeys(form.kind)[fieldIndex]
  const input = field === undefined ? undefined : inputs.get(field)
  if (field === undefined || input === undefined) return form
  const value = sanitizeTerminalText(input.getValue())
  if (value !== input.getValue()) input.setValue(value)
  return Object.freeze({ ...form, [field]: value })
}

export function syncConnectionMetadataInputFocus(
  inputs: ReadonlyMap<EditableConnectionMetadataField, Input>,
  kind: ConnectionMetadataKind,
  fieldIndex: number,
  focused: boolean,
  stageIsFields: boolean,
): void {
  for (const input of inputs.values()) input.focused = false
  if (!focused || !stageIsFields) return
  const field = connectionMetadataFieldKeys(kind)[fieldIndex]
  if (field !== undefined) {
    const input = inputs.get(field)
    if (input !== undefined) input.focused = true
  }
}
