import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
} from '@earendil-works/pi-tui'

interface DynamicCommand {
  readonly name: string
  readonly description?: string
}

interface DynamicAutocompleteOptions {
  readonly commands: () => readonly DynamicCommand[]
  readonly basePath: string
  readonly fdPath?: string | null
}

/** Keeps command descriptions in sync with capabilities that change after each run. */
export class DynamicAutocompleteProvider implements AutocompleteProvider {
  readonly #options: DynamicAutocompleteOptions
  #signature = ''
  #delegate: CombinedAutocompleteProvider | undefined

  constructor(options: DynamicAutocompleteOptions) {
    this.#options = options
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { readonly signal: AbortSignal; readonly force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    return this.#current().getSuggestions(lines, cursorLine, cursorCol, options)
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.#current().applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.#current().shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
  }

  #current(): CombinedAutocompleteProvider {
    const commands = this.#options.commands().map((command) => ({ ...command }))
    const signature = JSON.stringify(commands)
    if (this.#delegate === undefined || signature !== this.#signature) {
      this.#signature = signature
      this.#delegate = new CombinedAutocompleteProvider(
        commands,
        this.#options.basePath,
        this.#options.fdPath ?? null,
      )
    }
    return this.#delegate
  }
}
