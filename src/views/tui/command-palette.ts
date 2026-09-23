import {
  Container,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from '@earendil-works/pi-tui'
import type { BraidTheme } from './theme.js'
import { ANALYSIS_COMMAND_SPECS } from '../../analysis/commands.js'

export type PaletteCommand =
  | 'help'
  | 'quit'
  | 'graph'
  | 'cancel'
  | 'supervisor'
  | 'cancel-worker'
  | `analysis:${string}`

const COMMANDS: SelectItem[] = [
  { value: 'help', label: '/help', description: 'Keyboard and commands' },
  { value: 'quit', label: '/quit', description: 'Close Braid' },
  { value: 'graph', label: '/graph', description: 'Show the committed graph snapshot' },
  { value: 'cancel', label: '/cancel', description: 'Cancel the active run' },
  { value: 'supervisor', label: '/supervisor <id>', description: 'Read runtime supervisor state' },
  {
    value: 'cancel-worker',
    label: '/cancel-worker <supervisor> <run> <worker|->',
    description: 'Cancel one runtime worker or root',
  },
  ...ANALYSIS_COMMAND_SPECS.map((command) => ({
    value: `analysis:${command.name}`,
    label: command.usage,
    description: command.summary,
  })),
]

export class CommandPalette extends Container {
  readonly #input = new Input()
  readonly #list: SelectList
  readonly #onCommand: (command: PaletteCommand) => void
  #focused = false

  constructor(theme: BraidTheme, onCommand: (command: PaletteCommand) => void) {
    super()
    this.#onCommand = onCommand
    this.#list = new SelectList(COMMANDS, 5, theme.select)
    this.#list.onSelect = (item) => this.#onCommand(item.value as PaletteCommand)
    this.#list.onCancel = () => this.#onCommand('help')
    this.#input.onSubmit = () => {
      const selected = this.#list.getSelectedItem()
      if (selected) this.#onCommand(selected.value as PaletteCommand)
    }
    this.#input.onEscape = () => this.#onCommand('help')
    this.addChild(new Text(theme.brand('Commands'), 1, 0))
    this.addChild(new Spacer(1))
    this.addChild(this.#input)
    this.addChild(new Spacer(1))
    this.addChild(this.#list)
    this.addChild(new Spacer(1))
    this.addChild(new Text(theme.muted('type to filter · esc to close'), 1, 0))
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    this.#input.focused = value
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'enter')) {
      this.#list.handleInput(data)
      return
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.#onCommand('help')
      return
    }
    this.#input.handleInput(data)
    this.#list.setFilter(this.#input.getValue().replace(/^\//u, ''))
  }
}
