import type {
  ConfigurationEffectiveValues,
  ConfigurationSelection,
  ConfigurationSessionOptions,
} from '../../app/configuration-session.js'
import type { ConfigurationCommit } from './configuration-credential.js'
import type { BraidTheme } from './theme.js'

export interface ConfigurationDiscovery extends ConfigurationSessionOptions {
  readonly diagnostics: readonly string[]
}

export interface ConfigurationWizardOptions extends ConfigurationSessionOptions {
  readonly theme: BraidTheme
  readonly onCommit: ConfigurationCommit
  readonly onComplete: (selection: ConfigurationSelection) => void
  readonly onCancel: () => void
  readonly confirmation?: (selection: ConfigurationSelection) => ConfigurationEffectiveValues
  readonly diagnostics?: readonly string[]
  readonly requestRender?: () => void
  readonly rows?: () => number
  readonly onReload?: () => Promise<ConfigurationDiscovery>
  readonly requiresCredential?: (connection: ConfigurationSelection['connection']) => boolean
}

export type TerminalConfigurationOptions = ConfigurationSessionOptions &
  Pick<ConfigurationWizardOptions, 'onCommit'> & {
    readonly openOnStart?: boolean
    readonly onCancel?: () => void
    readonly confirmation?: ConfigurationWizardOptions['confirmation']
    readonly diagnostics?: readonly string[]
    readonly onReload?: () => Promise<ConfigurationDiscovery>
    readonly requiresCredential?: ConfigurationWizardOptions['requiresCredential']
  }
