import {
  Container,
  Input,
  matchesKey,
  SelectList,
  Spacer,
  Text,
  type Focusable,
  type SelectItem,
} from '@earendil-works/pi-tui'
import type { SelectorView } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export interface SearchableSelectorOptions {
  readonly title: string
  readonly items: readonly SelectItem[]
  readonly theme: BraidTheme
  readonly maxVisible?: number
  readonly query?: string
  readonly footer?: string
  readonly onSelect: (item: SelectItem) => void
  readonly onCancel: () => void
}

function safeItem(item: SelectItem): SelectItem {
  return {
    ...item,
    label: sanitizeTerminalText(item.label),
    ...(item.description === undefined
      ? {}
      : { description: sanitizeTerminalText(item.description) }),
  }
}

export class SearchableSelector extends Container implements Focusable {
  readonly #input = new Input()
  #list: SelectList
  readonly #title: Text
  readonly #footer: Text
  readonly #onSelect: (item: SelectItem) => void
  readonly #onCancel: () => void
  #items: readonly SelectItem[]
  readonly #theme: BraidTheme
  readonly #maxVisible: number
  #focused = false

  constructor(options: SearchableSelectorOptions) {
    super()
    this.#items = options.items.map(safeItem)
    this.#theme = options.theme
    this.#maxVisible = options.maxVisible ?? 8
    this.#onSelect = options.onSelect
    this.#onCancel = options.onCancel
    this.#title = new Text(options.theme.brand(sanitizeTerminalText(options.title)), 1, 0)
    this.#footer = new Text(
      options.theme.muted(
        sanitizeTerminalText(options.footer ?? 'type to filter · enter to choose · esc to close'),
      ),
      1,
      0,
    )
    this.#list = this.#createList()
    this.#input.setValue(options.query ?? '')
    this.#input.onSubmit = () => {
      const item = this.#list.getSelectedItem()
      if (item) this.#onSelect(item)
    }
    this.#input.onEscape = () => this.#onCancel()
    this.#list.onSelect = (item) => this.#onSelect(item)
    this.#list.onCancel = () => this.#onCancel()
    this.addChild(this.#title)
    this.addChild(new Spacer(1))
    this.addChild(this.#input)
    this.addChild(new Spacer(1))
    this.addChild(this.#list)
    this.addChild(new Spacer(1))
    this.addChild(this.#footer)
    this.#applyFilter()
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    this.#input.focused = value
  }

  setItems(items: readonly SelectItem[]): void {
    const previous = this.#list.getSelectedItem()?.value
    const oldList = this.#list
    this.#items = items.map(safeItem)
    this.#list = this.#createList()
    const index = this.children.indexOf(oldList)
    if (index >= 0) this.children[index] = this.#list
    this.#applyFilter()
    if (previous) {
      const selectedIndex = this.#items.findIndex((item) => item.value === previous)
      if (selectedIndex >= 0) this.#list.setSelectedIndex(selectedIndex)
    }
    this.invalidate()
  }

  setQuery(query: string): void {
    this.#input.setValue(query)
    this.#applyFilter()
    this.invalidate()
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, 'up') ||
      matchesKey(data, 'down') ||
      matchesKey(data, 'pageUp') ||
      matchesKey(data, 'pageDown')
    ) {
      this.#list.handleInput(data)
      return
    }
    if (matchesKey(data, 'enter')) {
      this.#list.handleInput(data)
      return
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.#onCancel()
      return
    }
    this.#input.handleInput(data)
    this.#applyFilter()
  }

  #applyFilter(): void {
    this.#list.setFilter(this.#input.getValue())
  }

  #createList(): SelectList {
    const list = new SelectList([...this.#items], this.#maxVisible, this.#theme.select)
    list.onSelect = (item) => this.#onSelect(item)
    list.onCancel = () => this.#onCancel()
    return list
  }
}

export function selectorItems(view: SelectorView): SelectItem[] {
  return view.items.map((item) => ({
    value: item.id,
    label: sanitizeTerminalText(item.label),
    ...((item.unavailableReason ?? item.description)
      ? { description: sanitizeTerminalText(item.unavailableReason ?? item.description ?? '') }
      : {}),
  }))
}
