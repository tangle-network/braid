import type {
  ActivityNote,
  NodeSnapshot,
  NodeStatus,
  RootHandle,
  TreeView,
} from '@tangle-network/agent-runtime/kernel'
import { sanitizeDiagnosticText } from '../analysis/diagnostics.js'
import { sanitizeTerminalText } from '../views/shared/sanitize.js'

export interface SupervisorWorkerSnapshot {
  readonly node: NodeSnapshot
  readonly activity: readonly ActivityNote[]
  readonly logTail: readonly string[]
}

export interface SupervisorSnapshot {
  readonly supervisorId: string
  readonly runId: string
  readonly revision: number
  readonly status: NodeStatus | 'unknown'
  readonly observedAt: string
  readonly tree: TreeView | null
  readonly workers: readonly SupervisorWorkerSnapshot[]
  readonly connected: boolean
}

export interface CancellationCommand {
  readonly operationId: string
  readonly supervisorId: string
  readonly runId: string
  readonly workerId?: string
  readonly reason: string
}

export interface CancellationReceipt {
  readonly operationId: string
  readonly supervisorId: string
  readonly runId: string
  readonly workerId?: string
  readonly status: 'accepted'
  readonly effect: 'requested'
}

export interface SupervisorWatchOptions {
  readonly supervisorId: string
  readonly afterRevision?: number
  readonly intervalMs?: number
  readonly signal?: AbortSignal
}

export interface RuntimeSupervisorPort {
  reconnect(supervisorId: string): Promise<SupervisorSnapshot>
  snapshot(supervisorId: string): Promise<SupervisorSnapshot>
  watch(options: SupervisorWatchOptions): AsyncIterable<SupervisorSnapshot>
  cancel(command: CancellationCommand): Promise<CancellationReceipt>
}

/** Runtime-owned root and observation hooks for one exact supervisor run. */
export interface RuntimeSupervisorClient {
  readonly supervisorId: string
  readonly runId: string
  readonly root: RootHandle<unknown>
  readonly revision: () => number | Promise<number>
  readonly observedAt?: () => string
  readonly readActivity?: (node: NodeSnapshot) => readonly ActivityNote[]
  readonly readLogTail?: (node: NodeSnapshot, limit: number) => readonly string[]
}

export interface RuntimeSupervisorAdapterOptions {
  readonly resolve: (supervisorId: string) => Promise<RuntimeSupervisorClient>
  readonly logTailLimit?: number
  readonly now?: () => string
}

/** Adapter over the runtime's public root handle; Braid owns no supervisor files or protocol. */
export class PublicRuntimeSupervisorAdapter implements RuntimeSupervisorPort {
  private readonly resolve: RuntimeSupervisorAdapterOptions['resolve']
  private readonly logTailLimit: number
  private readonly now: () => string
  private readonly clients = new Map<string, RuntimeSupervisorClient>()
  private readonly runIds = new Map<string, string>()

  constructor(options: RuntimeSupervisorAdapterOptions) {
    this.resolve = options.resolve
    this.logTailLimit = boundedInteger(options.logTailLimit, 40, 40)
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async reconnect(supervisorId: string): Promise<SupervisorSnapshot> {
    this.clients.delete(supervisorId)
    const client = await this.connect(supervisorId)
    return this.readSnapshot(supervisorId, client)
  }

  async snapshot(supervisorId: string): Promise<SupervisorSnapshot> {
    const client = await this.clientFor(supervisorId)
    return this.readSnapshot(supervisorId, client)
  }

  async *watch(options: SupervisorWatchOptions): AsyncIterable<SupervisorSnapshot> {
    let afterRevision = options.afterRevision ?? -1
    const intervalMs = boundedInteger(options.intervalMs, 25, 60_000, 1)
    while (!options.signal?.aborted) {
      try {
        const client = await this.clientFor(options.supervisorId)
        const snapshot = await this.readSnapshot(options.supervisorId, client)
        if (snapshot.revision > afterRevision) {
          afterRevision = snapshot.revision
          yield snapshot
        }
      } catch {
        if (options.signal?.aborted) return
        this.clients.delete(options.supervisorId)
      }
      if (options.signal?.aborted) return
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  async cancel(command: CancellationCommand): Promise<CancellationReceipt> {
    const client = await this.clientFor(command.supervisorId)
    assertRunIdentity(client, command.runId)
    if (command.workerId !== undefined)
      throw new Error(
        'Runtime root control cannot cancel one worker without a runtime control client',
      )
    client.root.abort(sanitizeDiagnosticText(command.reason, 'Cancelled by user'))
    return {
      operationId: command.operationId,
      supervisorId: command.supervisorId,
      runId: command.runId,
      status: 'accepted',
      effect: 'requested',
    }
  }

  private async clientFor(supervisorId: string): Promise<RuntimeSupervisorClient> {
    const cached = this.clients.get(supervisorId)
    if (cached) return cached
    return this.connect(supervisorId)
  }

  private async connect(supervisorId: string): Promise<RuntimeSupervisorClient> {
    const client = await this.resolve(supervisorId)
    assertClientIdentity(client, supervisorId)
    const previousRunId = this.runIds.get(supervisorId)
    if (previousRunId && previousRunId !== client.runId)
      throw new Error(`Supervisor ${supervisorId} changed run identity`)
    this.runIds.set(supervisorId, client.runId)
    this.clients.set(supervisorId, client)
    return client
  }

  private async readSnapshot(
    supervisorId: string,
    client: RuntimeSupervisorClient,
  ): Promise<SupervisorSnapshot> {
    assertClientIdentity(client, supervisorId)
    const revision = await client.revision()
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error(`Supervisor revision is invalid: ${String(revision)}`)
    return this.fromTree(supervisorId, revision, client.root.view(), client)
  }

  private fromTree(
    supervisorId: string,
    revision: number,
    tree: TreeView,
    client: RuntimeSupervisorClient,
  ): SupervisorSnapshot {
    const safeTree = immutableSanitized(tree)
    const root = safeTree.nodes.find((node) => node.id === safeTree.root)
    return immutableSanitized({
      supervisorId,
      runId: client.runId,
      revision,
      status: root?.status ?? (tree.inFlight > 0 ? 'running' : 'unknown'),
      observedAt: client.observedAt?.() ?? this.now(),
      tree: safeTree,
      connected: true,
      workers: safeTree.nodes.map((node) => ({
        node,
        activity: immutableSanitized(client.readActivity?.(node) ?? []),
        logTail: boundedLogs(
          client.readLogTail?.(node, this.logTailLimit) ?? [],
          this.logTailLimit,
        ),
      })),
    })
  }
}

function immutableSanitized<T>(value: T): T {
  const clone = structuredClone(value)
  const stack: object[] = [clone as object]
  const seen = new Set<object>()
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || seen.has(current)) continue
    seen.add(current)
    for (const key of Object.keys(current)) {
      const child = (current as Record<string, unknown>)[key]
      if (typeof child === 'string')
        (current as Record<string, unknown>)[key] = sanitizeTerminalText(child)
      else if (child && typeof child === 'object') stack.push(child)
    }
    Object.freeze(current)
  }
  return clone
}

function boundedLogs(lines: readonly string[], limit: number): readonly string[] {
  if (limit === 0) return []
  return lines.slice(-limit).map((line) => {
    const clean = sanitizeDiagnosticText(sanitizeTerminalText(String(line)), '<redacted>')
    return clean.length > 4_096 ? `${clean.slice(0, 4_095)}…` : clean
  })
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  minimum = 0,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)))
}

function assertClientIdentity(client: RuntimeSupervisorClient, supervisorId: string): void {
  if (client.supervisorId !== supervisorId)
    throw new Error(`Supervisor client is bound to ${client.supervisorId}, not ${supervisorId}`)
  if (client.runId.length === 0) throw new Error('Supervisor client has no run identity')
}

function assertRunIdentity(client: RuntimeSupervisorClient, runId: string): void {
  if (client.runId !== runId)
    throw new Error(`Supervisor client is bound to run ${client.runId}, not ${runId}`)
}
