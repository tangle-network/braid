import {
  type Component,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
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
  readonly selectedValue?: string
  readonly footer?: string
  readonly emptyText?: string
  readonly noMatchText?: string
  readonly hideInputWhenEmpty?: boolean
  readonly embedded?: boolean
  readonly onAction?: (key: string, item: SelectItem | null) => void
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
  readonly #onAction: SearchableSelectorOptions['onAction']
  #items: readonly SelectItem[]
  readonly #theme: BraidTheme
  readonly #maxVisible: number
  readonly #emptyText: string | undefined
  readonly #noMatchText: string | undefined
  readonly #inputHidden: boolean
  #focused = false
  readonly #selectedValue: string | undefined

  constructor(options: SearchableSelectorOptions) {
    super()
    this.#items = options.items.map(safeItem)
    this.#theme = options.theme
    this.#maxVisible = Math.max(1, Math.min(10, Math.floor(options.maxVisible ?? 8)))
    this.#emptyText = safeOptionalText(options.emptyText)
    this.#noMatchText = safeOptionalText(options.noMatchText)
    this.#inputHidden = options.hideInputWhenEmpty === true && this.#items.length === 0
    this.#selectedValue = options.selectedValue
    this.#onSelect = options.onSelect
    this.#onCancel = options.onCancel
    this.#onAction = options.onAction
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
    if (options.embedded === true) {
      if (!this.#inputHidden) this.addChild(this.#input)
      this.addChild(this.#list)
    } else {
      this.addChild(this.#title)
      this.addChild(new SelectorRule(this.#theme))
      if (!this.#inputHidden) this.addChild(this.#input)
      this.addChild(this.#list)
      this.addChild(new SelectorRule(this.#theme))
      this.addChild(this.#footer)
    }
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
    this.#items = items.map(safeItem)
    this.#applyFilter()
  }

  setQuery(query: string): void {
    this.#input.setValue(query)
    this.#applyFilter()
    this.invalidate()
  }

  setFooter(footer: string): void {
    this.#footer.setText(this.#theme.muted(sanitizeTerminalText(footer)))
    this.invalidate()
  }

  selectedItem(): SelectItem | undefined {
    return this.#list.getSelectedItem() ?? undefined
  }

  handleInput(data: string): void {
    if (this.#onAction !== undefined) {
      const key = actionKey(data)
      if (key !== undefined) {
        this.#onAction(key, this.#list.getSelectedItem())
        return
      }
    }
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
    if (this.#inputHidden) return
    this.#input.handleInput(data)
    this.#applyFilter()
  }

  #applyFilter(): void {
    const previous = this.#list.getSelectedItem()?.value ?? this.#selectedValue
    const query = this.#input.getValue().trim().toLocaleLowerCase()
    const items = fuzzyFilter([...this.#items], query, (item) =>
      [item.label, item.value, item.description]
        .filter((value): value is string => value !== undefined)
        .join(' '),
    )
    const oldList = this.#list
    this.#list = this.#createList(items)
    const index = this.children.indexOf(oldList)
    if (index >= 0) this.children[index] = this.#list
    if (previous) {
      const selectedIndex = items.findIndex((item) => item.value === previous)
      if (selectedIndex >= 0) this.#list.setSelectedIndex(selectedIndex)
    }
    this.invalidate()
  }

  #createList(items: readonly SelectItem[] = this.#items): SelectList {
    const message = this.#items.length === 0 ? this.#emptyText : this.#noMatchText
    const selectTheme =
      message === undefined
        ? this.#theme.select
        : { ...this.#theme.select, noMatch: () => this.#theme.select.noMatch(`  ${message}`) }
    const list = new SelectList([...items], this.#maxVisible, selectTheme)
    list.onSelect = (item) => this.#onSelect(item)
    list.onCancel = () => this.#onCancel()
    return list
  }
}

class SelectorRule implements Component {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    this.#theme = theme
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [this.#theme.muted('─'.repeat(Math.max(1, Math.floor(width))))]
  }
}

function safeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const safe = sanitizeTerminalText(value).trim()
  return safe.length === 0 ? undefined : safe
}

function actionKey(data: string): string | undefined {
  if (matchesKey(data, 'ctrl+n')) return 'new'
  if (matchesKey(data, 'ctrl+v')) return 'validate'
  if (matchesKey(data, 'ctrl+s')) return 'save'
  if (matchesKey(data, 'ctrl+t')) return 'test'
  if (matchesKey(data, 'ctrl+r')) return 'rename'
  if (matchesKey(data, 'ctrl+a')) return 'archive'
  if (matchesKey(data, 'ctrl+d')) return 'delete'
  return undefined
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
