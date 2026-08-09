import { Container, type Focusable, Text } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type {
  ConfigurationSelection,
  ConfigurationSession,
} from '../../app/configuration-session.js'
import { MaskedSecretInput, type OwnedSecretBytes } from './secret-input.js'
import type { BraidTheme } from './theme.js'

export interface ConfigurationCredentialOptions {
  readonly theme: BraidTheme
  readonly connectionName: string
  readonly error?: string
  readonly onSubmit: (credential: OwnedSecretBytes) => void
  readonly onCancel: () => void
}

export type ConfigurationCommit = (
  selection: ConfigurationSelection,
  credential?: OwnedSecretBytes,
) => void | Promise<void>

export class PreparedCredential {
  #value: OwnedSecretBytes | undefined

  get value(): OwnedSecretBytes | undefined {
    return this.#value
  }

  get prepared(): boolean {
    return this.#value !== undefined
  }

  replace(value: OwnedSecretBytes): void {
    this.clear()
    this.#value = value
  }

  clear(): void {
    this.#value?.fill(0)
    this.#value = undefined
  }
}

interface MountedCredentialOptions extends ConfigurationCredentialOptions {
  readonly container: Container
  readonly focused: boolean
  readonly requestRender?: () => void
}

export function configurationNeedsCredential(
  session: ConfigurationSession,
  requirement: ((connection: ConfigurationSelection['connection']) => boolean) | undefined,
): boolean {
  if (requirement === undefined) return false
  try {
    return requirement(session.previewSelection().connection)
  } catch {
    return false
  }
}

export function mountConfigurationCredential(
  options: MountedCredentialOptions,
): ConfigurationCredential {
  options.container.clear()
  options.container.addChild(new Text(options.theme.brand('braid setup'), 1, 0))
  const control = new ConfigurationCredential(options)
  control.focused = options.focused
  options.container.addChild(control)
  options.container.invalidate()
  options.requestRender?.()
  return control
}

/** Short-lived credential prompt; it never receives or returns immutable secret text. */
export class ConfigurationCredential extends Container implements Focusable {
  readonly #input: MaskedSecretInput
  #focused = false

  constructor(options: ConfigurationCredentialOptions) {
    super()
    this.#input = new MaskedSecretInput({
      onSubmit: options.onSubmit,
      onCancel: options.onCancel,
    })
    this.addChild(
      new Text(
        options.theme.brand(`credential · ${sanitizeTerminalText(options.connectionName)}`),
        1,
        0,
      ),
    )
    if (options.error !== undefined) {
      this.addChild(new Text(options.theme.danger(sanitizeTerminalText(options.error)), 1, 0))
    }
    this.addChild(
      new Text(
        options.theme.muted(
          'Saved by your secure credential manager; Braid keeps only a reference.',
        ),
        1,
        0,
      ),
    )
    this.addChild(this.#input)
    this.addChild(new Text(options.theme.muted('enter continue · esc back'), 1, 0))
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    this.#input.focused = value
  }

  handleInput(data: string): void {
    this.#input.handleInput(data)
  }

  dispose(): void {
    this.#input.dispose()
  }
}
