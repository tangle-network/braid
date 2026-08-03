import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import type { BraidViewModel, GraphNodeView } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export class GraphView extends Container {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.clear()
    this.addChild(new Text(this.#theme.brand('conversation graph'), 1, 0))
    this.addChild(new Spacer(1))
    if (view.graph.length === 0) {
      this.addChild(new Text(this.#theme.muted('No graph nodes are available.'), 1, 0))
    } else {
      for (const node of view.graph) this.addChild(this.#node(node))
    }
    this.invalidate()
  }

  #node(node: GraphNodeView): Text {
    const edge = node.edgeLabel ? ` ─${sanitizeTerminalText(node.edgeLabel)}→ ` : ''
    const indent = '  '.repeat(Math.max(0, node.depth))
    const label = `${indent}${edge}${sanitizeTerminalText(node.type)} ${sanitizeTerminalText(node.title)}`
    const status = sanitizeTerminalText(node.status)
    return new Text(`${this.#theme.muted(status.padEnd(12))} ${label}`, 1, 0)
  }
}
