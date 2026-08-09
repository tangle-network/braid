import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from '@earendil-works/pi-tui'

const COMPLETION_SNAPSHOT = Symbol('braid-completion-snapshot')

interface CompletionSnapshot {
  readonly generation: number
  readonly text: string
  readonly cursorLine: number
  readonly cursorCol: number
  readonly prefix: string
}

type GuardedAutocompleteItem = AutocompleteItem & {
  readonly [COMPLETION_SNAPSHOT]?: CompletionSnapshot
}

/**
 * Keeps Pi's autocomplete UI from applying an item computed for an older
 * editor state while a newer request is still in flight.
 *
 * Behavioral reference: Pi's request-id/text/cursor validation in
 * pi-mono@fa07e7b packages/tui/src/components/editor.ts. This wrapper adds
 * apply-time validation around the published 0.83 provider contract.
 */
export class GuardedAutocompleteProvider implements AutocompleteProvider {
  readonly #delegate: AutocompleteProvider
  #generation = 0

  constructor(delegate: AutocompleteProvider) {
    this.#delegate = delegate
  }

  get triggerCharacters(): string[] {
    return this.#delegate.triggerCharacters ?? []
  }

  /** Invalidate all suggestions that were computed before this edit. */
  inputChanged(): void {
    this.#generation += 1
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { readonly signal: AbortSignal; readonly force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const generation = this.#generation
    const text = lines.join('\n')
    const suggestions = await this.#delegate.getSuggestions(lines, cursorLine, cursorCol, options)
    if (!suggestions) return null

    const snapshot: CompletionSnapshot = {
      generation,
      text,
      cursorLine,
      cursorCol,
      prefix: suggestions.prefix,
    }
    return {
      prefix: suggestions.prefix,
      items: suggestions.items.map((item) =>
        Object.assign({}, item, { [COMPLETION_SNAPSHOT]: snapshot }),
      ),
    }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const snapshot = (item as GuardedAutocompleteItem)[COMPLETION_SNAPSHOT]
    const currentText = lines.join('\n')
    if (
      !snapshot ||
      snapshot.generation !== this.#generation ||
      snapshot.text !== currentText ||
      snapshot.cursorLine !== cursorLine ||
      snapshot.cursorCol !== cursorCol ||
      snapshot.prefix !== prefix
    ) {
      return { lines: [...lines], cursorLine, cursorCol }
    }
    return this.#delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }

  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.#delegate.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
  }
}
