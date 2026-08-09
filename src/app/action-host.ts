import type { BraidState } from '../domain/state.js'
import type { ConfigurationActionTransition } from './configuration-action-transition.js'
import type { RuntimeSelection } from './runtime-selection.js'

export interface ActionHost {
  readonly state: () => BraidState
  readonly configuration: ConfigurationActionTransition
  readonly runtime?: RuntimeSelection
}
