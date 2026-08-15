import { matchesKey } from '@earendil-works/pi-tui'
import { effectiveElapsedMs, formatDuration } from '../shared/duration.js'
import type { BraidViewModel, EntityDetailView, GraphNodeView } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import {
  EntityBrowser,
  type EntityBrowserDocument,
  type EntityBrowserRow,
} from './entity-browser.js'
import { executionTargetFor, executionTargetForEntity } from './execution-target.js'
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
  readonly #view: () => BraidViewModel | undefined
  readonly #collapsed: Set<string>
  readonly #localNotice: { value: string | undefined }

  constructor(theme: BraidTheme, options: GraphViewOptions = {}) {
    let staticView: BraidViewModel | undefined
    const collapsed = new Set<string>()
    const localNotice: { value: string | undefined } = { value: undefined }
    const currentView = (): BraidViewModel | undefined => options.view?.() ?? staticView
    super(theme, {
      document: (selectedId) => {
        const view = currentView()
        const notice = [options.notice?.(), localNotice.value]
          .filter((value): value is string => value !== undefined)
          .join(' · ')
        return view === undefined
          ? emptyGraphDocument()
          : graphDocument(view, notice || undefined, collapsed, selectedId)
      },
      rows: options.rows ?? (() => 12),
      onClose: options.onClose ?? (() => {}),
      ...(options.selectedId === undefined ? {} : { selectedId: options.selectedId }),
    })
    this.#setStaticView = (view) => {
      staticView = view
    }
    this.#view = currentView
    this.#collapsed = collapsed
    this.#localNotice = localNotice
  }

  setView(view: BraidViewModel): void {
    this.#setStaticView(view)
    this.selectId(`branch:${view.branch}`)
  }

  override handleInput(data: string): void {
    if (matchesKey(data, 'space') || data === ' ') {
      this.#toggleSelected()
      return
    }
    if (data.toLowerCase() === 'w') {
      this.#selectWaitingRun()
      return
    }
    super.handleInput(data)
  }

  #toggleSelected(): void {
    const view = this.#view()
    const selectedId = this.selectedId
    if (view === undefined || selectedId === undefined) return
    const hasChildren = view.graph.some((node) => node.parentIds?.includes(selectedId) === true)
    if (!hasChildren) {
      this.#localNotice.value = 'The selected item has no descendants.'
      this.invalidate()
      return
    }
    if (this.#collapsed.has(selectedId)) this.#collapsed.delete(selectedId)
    else this.#collapsed.add(selectedId)
    this.#localNotice.value = undefined
    this.invalidate()
  }

  #selectWaitingRun(): void {
    const view = this.#view()
    if (view === undefined) return
    const visible = visibleGraphNodes(view.graph, this.#collapsed)
    const visibleIds = new Set(visible.map((node) => `${node.type}:${node.id}`))
    const interactionRun = view.interactions.find((interaction) =>
      visibleIds.has(`run:${interaction.runId}`),
    )?.runId
    const waitingRun = visible.find((node) => node.type === 'run' && node.status === 'waiting')?.id
    const runId = interactionRun ?? waitingRun
    if (runId !== undefined) {
      this.#localNotice.value = undefined
      this.selectId(`run:${runId}`)
      return
    }

    const pendingRunId = view.interactions[0]?.runId
    const pendingIsFiltered =
      pendingRunId !== undefined &&
      !view.graph.some((node) => node.type === 'run' && node.id === pendingRunId)
    const hiddenWaiting = view.graph.some(
      (node) =>
        node.type === 'run' &&
        (node.status === 'waiting' || node.id === pendingRunId) &&
        !visibleIds.has(`run:${node.id}`),
    )
    this.#localNotice.value = pendingIsFiltered
      ? 'A waiting run is hidden by the current graph query.'
      : hiddenWaiting
        ? 'A waiting run is inside a collapsed item.'
        : 'No run is waiting for input.'
    this.invalidate()
  }
}

export function graphDocument(
  view: BraidViewModel,
  notice?: string,
  collapsed: ReadonlySet<string> = new Set(),
  selectedId?: string,
): EntityBrowserDocument {
  const details = new Map(
    (view.entityDetails ?? []).map((detail) => [detailKey(detail), detail] as const),
  )
  const hidden =
    view.hiddenGraphNodeCount === undefined
      ? undefined
      : `${view.hiddenGraphNodeCount} older graph nodes omitted; use get_graph for complete history`
  const combinedNotice = [notice, hidden].filter((value): value is string => value !== undefined)
  const selectedNode = view.graph.find((node) => `${node.type}:${node.id}` === selectedId)
  const target =
    selectedNode === undefined
      ? executionTargetFor(view)
      : executionTargetForEntity(view, selectedNode.type, selectedNode.id)
  const visible = visibleGraphNodes(view.graph, collapsed)
  const parentIds = new Set(view.graph.flatMap((node) => node.parentIds ?? []))
  const graphQuery = view.graphQuery?.trim()
  return {
    title: 'conversation graph',
    context: `${target.profileName} · ${target.runner} · ${target.model}`,
    ...(combinedNotice.length === 0 ? {} : { notice: combinedNotice.join(' · ') }),
    filterHint: `${graphQuery ? `filter: ${graphQuery} · ` : ''}space collapse · w waiting`,
    emptyMessage: 'The first run creates the first graph node.',
    rows: visible.map((node) =>
      rowFor(node, view.branch, details, collapsed, parentIds.has(`${node.type}:${node.id}`)),
    ),
  }
}

export function visibleGraphNodes(
  nodes: readonly GraphNodeView[],
  collapsed: ReadonlySet<string>,
): readonly GraphNodeView[] {
  if (collapsed.size === 0) return nodes
  const children = new Map<string, string[]>()
  for (const node of nodes) {
    const key = `${node.type}:${node.id}`
    for (const parentId of node.parentIds ?? []) {
      const values = children.get(parentId) ?? []
      values.push(key)
      children.set(parentId, values)
    }
  }
  const hidden = new Set<string>()
  const queue = [...collapsed]
  for (let cursor = 0; cursor < queue.length && cursor < 1024; cursor += 1) {
    const parentId = queue[cursor]
    if (parentId === undefined) continue
    for (const childId of children.get(parentId) ?? []) {
      if (hidden.has(childId)) continue
      hidden.add(childId)
      queue.push(childId)
    }
  }
  return nodes.filter((node) => !hidden.has(`${node.type}:${node.id}`))
}

function rowFor(
  node: GraphNodeView,
  currentBranch: string,
  details: ReadonlyMap<string, EntityDetailView>,
  collapsed: ReadonlySet<string>,
  hasChildren: boolean,
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
    title: `${hasChildren ? (collapsed.has(`${node.type}:${node.id}`) ? '▸ ' : '▾ ') : ''}${displayTitle(node)}`,
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
