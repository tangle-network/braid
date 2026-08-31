import { type Container, Text } from '@earendil-works/pi-tui'
import type {
  ConfigurationEffectiveValues,
  ConfigurationSelection,
  ConfigurationSession,
  ConfigurationSessionState,
} from '../../app/configuration-session.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { ConfigurationReview } from './configuration-review.js'
import {
  CANCEL_CONFIGURATION,
  configurationExplanation,
  configurationFooter,
  configurationItems,
  configurationReviewSummaries,
  configurationTitle,
  DOWN_ARROW,
} from './configuration-wizard-presentation.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'

export type ConfigurationStageControl = SearchableSelector | ConfigurationReview

export interface ConfigurationStageOptions {
  readonly container: Container
  readonly session: ConfigurationSession
  readonly state: ConfigurationSessionState
  readonly theme: BraidTheme
  readonly confirmation?: (selection: ConfigurationSelection) => ConfigurationEffectiveValues
  readonly credentialPrepared: boolean
  readonly diagnostics: readonly string[]
  readonly busy: boolean
  readonly commitError?: string
  readonly focused: boolean
  readonly onSelect: (value: string) => void
  readonly onCancel: () => void
  readonly requestRender?: () => void
}

export function renderConfigurationStage(
  options: ConfigurationStageOptions,
): ConfigurationStageControl {
  const { container, state, theme, busy, commitError, focused, onSelect, onCancel } = options
  container.clear()
  const applied = state.step === 'complete' && !busy && commitError === undefined
  container.addChild(new Text(theme.brand('braid setup'), 1, 0))
  if (state.step !== 'confirm' && state.step !== 'complete') {
    container.addChild(new Text(theme.muted(configurationExplanation(state)), 1, 0))
    for (const diagnostic of options.diagnostics)
      container.addChild(
        new Text(theme.warning(`notice · ${sanitizeTerminalText(diagnostic)}`), 1, 0),
      )
  }
  if (commitError !== undefined && state.step !== 'confirm' && state.step !== 'complete')
    container.addChild(new Text(theme.danger(sanitizeTerminalText(commitError)), 1, 0))
  const control: ConfigurationStageControl =
    state.step === 'confirm' || state.step === 'complete'
      ? new ConfigurationReview({
          theme,
          ...configurationReviewSummaries(
            options.session,
            state,
            options.confirmation,
            options.credentialPrepared,
          ),
          title: applied ? 'selection applied' : configurationTitle(state, busy, commitError),
          ...(commitError === undefined ? {} : { error: commitError }),
          items: applied
            ? [{ value: CANCEL_CONFIGURATION, label: 'Close', description: '←/esc close' }]
            : configurationItems(state, busy, commitError),
          onSelect: (item) => onSelect(item.value),
          onCancel,
        })
      : new SearchableSelector({
          title: configurationTitle(state, busy, commitError),
          items: configurationItems(state, busy, commitError),
          maxVisible: 4,
          theme,
          footer: configurationFooter(state, busy),
          onSelect: (item) => onSelect(item.value),
          onCancel,
        })
  control.focused = focused
  restoreSelection(control, state, busy, commitError)
  container.addChild(control)
  container.invalidate()
  options.requestRender?.()
  return control
}

function restoreSelection(
  control: ConfigurationStageControl,
  state: ConfigurationSessionState,
  busy: boolean,
  commitError: string | undefined,
): void {
  if (!(control instanceof SearchableSelector)) return
  const selectedValue =
    state.step === 'profile'
      ? state.selectedProfileId
      : state.step === 'connection'
        ? state.selectedConnectionId
        : undefined
  if (selectedValue === undefined) return
  const index = configurationItems(state, busy, commitError).findIndex(
    (item) => item.value === selectedValue,
  )
  for (let offset = 0; offset < index; offset += 1) control.handleInput(DOWN_ARROW)
}
