import type { BraidViewModel, GraphNodeView } from '../shared/models.js'
import { SurfacePanel, safeText } from './surface-panel.js'
import type { BraidTheme } from './theme.js'

export class GraphView extends SurfacePanel {
  #view: BraidViewModel | undefined

  constructor(theme: BraidTheme) {
    super({
      title: 'conversation graph',
      theme,
      footer: 'up/down move  ·  enter inspect  ·  esc close',
    })
  }

  setView(view: BraidViewModel): void {
    this.#view = view
  }

  protected body(width: number): string[] {
    const nodes = this.#view?.graph ?? []
    if (nodes.length === 0) return ['No graph nodes are available.']
    return nodes.map((node) => this.#node(node, width))
  }

  #node(node: GraphNodeView, width: number): string {
    const marker = node.id === this.#view?.selectedNodeId ? '> ' : '  '
    const indent = '  '.repeat(Math.max(0, node.depth))
    const edge = node.edgeLabel ? `|-- ${safeText(node.edgeLabel)} --> ` : ''
    const status = safeText(node.status)
    return `${marker}${indent}${edge}${safeText(node.type)}  ${safeText(node.title)}  [${status}]`.slice(
      0,
      Math.max(1, width),
    )
  }
}
