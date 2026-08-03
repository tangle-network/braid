import type { CapabilityMap } from '../shared/models.js'
import { commandItems, type CommandName } from '../shared/command-registry.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'

export type PaletteCommand = CommandName

const ALL_CAPABILITIES: CapabilityMap = Object.freeze({})

export class CommandPalette extends SearchableSelector {
  constructor(
    theme: BraidTheme,
    onCommand: (command: PaletteCommand) => void,
    capabilities: CapabilityMap = ALL_CAPABILITIES,
  ) {
    super({
      title: 'commands',
      items: commandItems(capabilities),
      theme,
      onSelect: (item) => onCommand(item.value as PaletteCommand),
      onCancel: () => onCommand('help'),
    })
  }
}
