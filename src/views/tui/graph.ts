import { Container, TruncatedText } from '@earendil-works/pi-tui'
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
    this.addChild(this.#line(this.#theme.brand('conversation graph · current branch')))
    this.addChild(
      this.#line(`${this.#theme.muted('branch:')} ${sanitizeTerminalText(view.branch)}`),
    )
    if (view.graph.length === 0) {
      this.addChild(this.#line(this.#theme.muted('No graph nodes are available.')))
    } else {
      const nodes = visibleNodes(view.graph, view.branch)
      for (const node of nodes) this.addChild(this.#node(node, view.branch))
      const visibleIds = new Set(nodes.map((node) => node.id))
      const hiddenCount = view.graph.filter((node) => !visibleIds.has(node.id)).length
      if (hiddenCount > 0)
        this.addChild(this.#line(this.#theme.muted(`+${hiddenCount} nodes not shown`)))
    }
    this.addChild(this.#line(this.#theme.muted('esc close')))
    this.invalidate()
  }

  #node(node: GraphNodeView, currentBranch: string): TruncatedText {
    const indent = '  '.repeat(Math.max(0, node.depth))
    const edgeName = displayEdge(node)
    const edge = edgeName ? `${edgeColor(this.#theme, edgeName)} ` : ''
    const current = node.type === 'branch' && node.id === currentBranch
    const marker = current ? `${this.#theme.accent('› current')} ` : ''
    const label = `${indent}${node.depth > 0 ? '└ ' : ''}${marker}${edge}${sanitizeTerminalText(node.type)} ${sanitizeTerminalText(node.title)}`
    const status = sanitizeTerminalText(node.status)
    const statusText =
      node.status === 'failed' || node.status === 'storage-failure'
        ? this.#theme.danger(status)
        : node.status === 'running' || node.status === 'waiting'
          ? this.#theme.warning(status)
          : this.#theme.muted(status)
    return this.#line(`${statusText} · ${label}`)
  }

  #line(value: string): TruncatedText {
    return new TruncatedText(value, 1, 0)
  }
}

function displayEdge(node: GraphNodeView): string | undefined {
  if (!node.edgeLabel) return undefined
  const edge = sanitizeTerminalText(node.edgeLabel).replace(/[_-]+/gu, ' ').trim()
  if (edge === 'compared left') return 'compared left'
  if (edge === 'compared right') return 'compared right'
  if (edge === 'analyzed') return 'analyzed'
  if (edge === 'attached' && node.type === 'analysis') return 'attached analysis'
  return edge
}

function edgeColor(theme: BraidTheme, edge: string): string {
  return /^(analyzed|compared)/u.test(edge) ? theme.accent(`─${edge}→`) : theme.muted(`─${edge}→`)
}

function visibleNodes(
  nodes: readonly GraphNodeView[],
  currentBranch: string,
): readonly GraphNodeView[] {
  const limit = 8
  const visible = nodes.slice(0, limit)
  if (visible.some((node) => node.id === currentBranch)) return visible
  const current = nodes.find((node) => node.id === currentBranch)
  if (current === undefined) return visible
  return [...visible.slice(0, limit - 1), current]
}
