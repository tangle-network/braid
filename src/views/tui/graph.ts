import type { BraidViewModel, EntityDetailView, GraphNodeView } from '../shared/models.js'
import { effectiveElapsedMs, formatDuration } from '../shared/duration.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import {
  EntityBrowser,
  type EntityBrowserDocument,
  type EntityBrowserRow,
} from './entity-browser.js'
import type { BraidTheme } from './theme.js'

export interface GraphViewOptions {
  readonly view?: () => BraidViewModel
  readonly rows?: () => number
  readonly onClose?: () => void
  readonly selectedId?: string
  readonly notice?: () => string | undefined
}

export class GraphView extends EntityBrowser {
  readonly #setStaticView: (view: BraidViewModel) => void

  constructor(theme: BraidTheme, options: GraphViewOptions = {}) {
    let staticView: BraidViewModel | undefined
    super(theme, {
      document: () => {
        const view = options.view?.() ?? staticView
        return view === undefined ? emptyGraphDocument() : graphDocument(view, options.notice?.())
      },
      rows: options.rows ?? (() => 12),
      onClose: options.onClose ?? (() => {}),
      ...(options.selectedId === undefined ? {} : { selectedId: options.selectedId }),
    })
    this.#setStaticView = (view) => {
      staticView = view
    }
  }

  setView(view: BraidViewModel): void {
    this.#setStaticView(view)
    this.selectId(`branch:${view.branch}`)
  }
}

export function graphDocument(view: BraidViewModel, notice?: string): EntityBrowserDocument {
  const details = new Map(
    (view.entityDetails ?? []).map((detail) => [detailKey(detail), detail] as const),
  )
  const hidden =
    view.hiddenGraphNodeCount === undefined
      ? undefined
      : `${view.hiddenGraphNodeCount} older graph nodes omitted; use get_graph for complete history`
  const combinedNotice = [notice, hidden].filter((value): value is string => value !== undefined)
  return {
    title: 'conversation graph',
    context: `${view.profileName} · ${view.runner} · ${view.model}`,
    ...(combinedNotice.length === 0 ? {} : { notice: combinedNotice.join(' · ') }),
    emptyMessage: 'The first run creates the first graph node.',
    rows: view.graph.map((node) => rowFor(node, view.branch, details)),
  }
}

function rowFor(
  node: GraphNodeView,
  currentBranch: string,
  details: ReadonlyMap<string, EntityDetailView>,
): EntityBrowserRow {
  const detail = details.get(`${node.type}:${node.id}`)
  const edge = displayEdge(node)
  const elapsed = effectiveElapsedMs(node.status, node.startedAt, node.elapsedMs)
  const meta = [
    edge === undefined ? undefined : `─${edge}→`,
    elapsed === undefined ? undefined : formatDuration(elapsed),
  ]
    .filter((value): value is string => value !== undefined)
    .join(' · ')
  return {
    id: `${node.type}:${node.id}`,
    kind: node.type,
    title: displayTitle(node),
    status: node.status,
    depth: node.depth,
    current: node.type === 'branch' && node.id === currentBranch,
    ...(meta.length === 0 ? {} : { meta }),
    detailLines: [
      ...(elapsed === undefined ? [] : [`elapsed: ${formatDuration(elapsed)}`]),
      ...(detail?.lines ?? [
        `id: ${sanitizeTerminalText(node.id)}`,
        `type: ${sanitizeTerminalText(node.type)}`,
        `status: ${sanitizeTerminalText(node.status)}`,
        ...(node.runner === undefined ? [] : [`runner: ${sanitizeTerminalText(node.runner)}`]),
        ...(node.costUsd === undefined ? [] : [`cost: $${node.costUsd.toFixed(4)}`]),
        ...(edge === undefined ? [] : [`relation: ${sanitizeTerminalText(edge)}`]),
      ]),
    ],
  }
}

function displayTitle(node: GraphNodeView): string {
  const title = sanitizeTerminalText(node.title)
  const repeated = `${node.type} ${node.id}`
  return title.toLocaleLowerCase() === repeated.toLocaleLowerCase()
    ? sanitizeTerminalText(node.id)
    : title
}

function displayEdge(node: GraphNodeView): string | undefined {
  if (!node.edgeLabel) return undefined
  const edge = sanitizeTerminalText(node.edgeLabel).replace(/[_-]+/gu, ' ').trim()
  if (edge === 'attached' && node.type === 'analysis') return 'attached analysis'
  return edge
}

function detailKey(detail: EntityDetailView): string {
  return `${detail.entityType}:${detail.entityId}`
}

function emptyGraphDocument(): EntityBrowserDocument {
  return {
    title: 'conversation graph',
    emptyMessage: 'The first run creates the first graph node.',
    rows: [],
  }
}
