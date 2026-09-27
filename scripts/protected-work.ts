import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

type Row = 'LIVE-06' | 'LIVE-07' | 'LIVE-08' | 'LIVE-09' | 'LIVE-10'
type Counter =
  | 'polls'
  | 'frameRequests'
  | 'stateRequests'
  | 'parentRequests'
  | 'parentCreates'
  | 'censusBarriers'
const COUNTERS: readonly Counter[] = [
  'polls',
  'frameRequests',
  'stateRequests',
  'parentRequests',
  'parentCreates',
  'censusBarriers',
]
interface Span {
  readonly row: Row
  readonly name: string
  readonly startedMs: number
  readonly finishedMs: number
  readonly outcome: 'settled' | 'threw'
}
interface Context {
  readonly work: ProtectedWork
  readonly row: Row
}
const context = new AsyncLocalStorage<Context>()

export class ProtectedWork {
  readonly startedAt = new Date().toISOString()
  readonly startedMs = performance.now()
  readonly #spans: Span[] = []
  readonly #counts = new Map<Row, Partial<Record<Counter, number>>>()
  readonly #windows: ProofWindow[] = []

  constructor(
    readonly overlap: boolean,
    readonly rollout = 'internal',
    readonly rolloutBucket: number | null = null,
  ) {}

  window(window: ProofWindow): void {
    this.#windows.push(window)
  }

  async span<T>(row: Row, name: string, operation: () => Promise<T>): Promise<T> {
    const startedMs = performance.now()
    let outcome: Span['outcome'] = 'threw'
    try {
      const value = await context.run({ work: this, row }, operation)
      outcome = 'settled'
      return value
    } finally {
      this.#spans.push({ row, name, startedMs, finishedMs: performance.now(), outcome })
    }
  }

  observed(row: Row, ...counters: Counter[]): void {
    const counts = this.#counts.get(row) ?? {}
    for (const counter of counters) counts[counter] ??= 0
    this.#counts.set(row, counts)
  }

  count(row: Row, counter: Counter): void {
    const counts = this.#counts.get(row) ?? {}
    counts[counter] = (counts[counter] ?? 0) + 1
    this.#counts.set(row, counts)
  }

  snapshot() {
    const rows: Row[] = ['LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10']
    return {
      schema: 'braid.protected-work.v1',
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      wallMs: performance.now() - this.startedMs,
      overlap: this.overlap ? 'post-canary' : 'off',
      rollout: this.rollout,
      rolloutBucket: this.rolloutBucket,
      proofWindows: this.#windows.map((window) => window.snapshot()),
      rows: rows.map((row) => ({
        row,
        counters: Object.fromEntries(
          COUNTERS.map((counter) => [counter, this.#counts.get(row)?.[counter] ?? null]),
        ),
        awaitedSpanCount: this.#spans.filter((span) => span.row === row).length,
        spans: this.#spans
          .filter((span) => span.row === row)
          .map((span) => ({
            name: span.name,
            startMs: span.startedMs - this.startedMs,
            endMs: span.finishedMs - this.startedMs,
            elapsedMs: span.finishedMs - span.startedMs,
            outcome: span.outcome,
          })),
      })),
      coverage: {
        polls: 'Instrumented proof-parent predicate evaluations only',
        parentRequests:
          'Actual wrapped LIVE-07/LIVE-08 proof-parent Sandbox.fetch calls; SDK retries counted',
        parentCreates:
          'Actual proof-parent POST /v1/sandboxes; excludes packed children and fork allocations',
        fullSandboxCreateRequests: null,
        packedChildRequests: null,
        serialWaitBarriers: null,
        runnerSlotSeconds: null,
        fullWorkflowWallSeconds: null,
        missingCounters: 'Null means this row has no instrumented observation for that counter',
      },
    }
  }
}

export function createProtectedWork(environment: NodeJS.ProcessEnv): ProtectedWork | undefined {
  const flag = environment.BRAID_PROTECTED_OVERLAP ?? 'off'
  const counters = environment.BRAID_PROTECTED_COUNTERS ?? '0'
  if (!['off', 'post-canary'].includes(flag) || !['0', '1'].includes(counters))
    throw new Error('Invalid protected work flag')
  if (flag === 'off' && counters === '0') return undefined
  if (environment.CI !== 'true' || environment.GITHUB_ACTIONS !== 'true')
    throw new Error('Protected work optimization and counters require CI')
  const rollout = environment.BRAID_PROTECTED_ROLLOUT ?? 'internal'
  if (!['internal', 'one-percent', 'broad'].includes(rollout))
    throw new Error('Invalid protected work rollout ring')
  const identity = environment.GITHUB_RUN_ID
  if (rollout === 'one-percent' && !/^\d+$/u.test(identity ?? ''))
    throw new Error('One-percent rollout requires the actual workflow run identity')
  const bucket =
    identity === undefined
      ? null
      : createHash('sha256').update(identity).digest().readUInt32BE(0) % 100
  const selected = rollout !== 'one-percent' || bucket === 0
  return new ProtectedWork(flag === 'post-canary' && selected, rollout, bucket)
}

export function countProtectedWork(counter: Counter): void {
  const active = context.getStore()
  active?.work.count(active.row, counter)
}

export function protectedSpan<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const active = context.getStore()
  return active === undefined ? operation() : active.work.span(active.row, name, operation)
}

/** Observe this owned SDK instance without inspecting headers, bodies or credentials. */
export function observeOwnedSandbox<T extends object>(client: T): T {
  if (context.getStore() === undefined) return client
  const original: unknown = Reflect.get(client, 'fetch')
  if (typeof original !== 'function')
    throw new Error('Sandbox transport observation is unavailable')
  const active = context.getStore()
  active?.work.observed(active.row, 'parentRequests', 'parentCreates')
  const wrapped = (...args: unknown[]) => {
    active?.work.count(active.row, 'parentRequests')
    const options = args[1]
    const method =
      options && typeof options === 'object' ? Reflect.get(options, 'method') : undefined
    if (
      typeof args[0] === 'string' &&
      /^\/v1\/sandboxes(?:\?|$)/u.test(args[0]) &&
      method === 'POST'
    )
      active?.work.count(active.row, 'parentCreates')
    return Reflect.apply(original, client, args)
  }
  if (!Reflect.set(client, 'fetch', wrapped))
    throw new Error('Sandbox transport cannot be observed')
  return client
}

/** Every scope performs its own observations; only their ordering is coordinated. */
export class ProofWindow {
  readonly #before = new Set<string>()
  readonly #cleaned = new Set<string>()
  readonly #beforeReady: Promise<void>
  readonly #cleanupReady: Promise<void>
  #releaseBefore!: () => void
  #releaseCleanup!: () => void
  #failure: Error | undefined
  readonly #scopes: Set<string>
  readonly #deadline = performance.now() + 900_000
  readonly #resources = new Map<
    string,
    { readonly scope: string; readonly runId: string; deleted: boolean }
  >()

  constructor(scopes: readonly string[]) {
    this.#scopes = new Set(scopes)
    if (this.#scopes.size !== scopes.length || scopes.length === 0)
      throw new Error('Proof window scope identities must be unique')
    context.getStore()?.work.window(this)
    this.#beforeReady = new Promise((resolve) => {
      this.#releaseBefore = resolve
    })
    this.#cleanupReady = new Promise((resolve) => {
      this.#releaseCleanup = resolve
    })
  }

  #scope(scope: string): void {
    if (!this.#scopes.has(scope)) throw new Error('Unknown proof window scope')
  }

  assertAdmission(): void {
    if (this.#failure !== undefined) throw this.#failure
  }

  admitted(scope: string, runId: string, environmentId: string): void {
    this.#scope(scope)
    if (!runId || !environmentId) throw new Error('Exact resource admission is incomplete')
    const prior = this.#resources.get(environmentId)
    if (prior !== undefined && (prior.scope !== scope || prior.runId !== runId))
      throw new Error('Protected scopes reused an environment identity')
    if (prior === undefined) this.#resources.set(environmentId, { scope, runId, deleted: false })
  }

  deleted(scope: string, environmentId: string): void {
    this.#scope(scope)
    const admission = this.#resources.get(environmentId)
    if (admission === undefined || admission.scope !== scope)
      throw new Error('Deletion receipt is not bound to this proof admission')
    admission.deleted = true
  }

  snapshot() {
    return {
      scopes: [...this.#scopes],
      beforeObserved: [...this.#before],
      cleanupSettled: [...this.#cleaned],
      failure: this.#failure !== undefined,
      maximumWaitMs: 900_000,
      exactResources: [...this.#resources].map(([environmentId, admission]) => ({
        environmentId,
        ...admission,
      })),
    }
  }

  async #wait(ready: Promise<void>, phase: string): Promise<void> {
    countProtectedWork('censusBarriers')
    const remainingMs = this.#deadline - performance.now()
    if (remainingMs <= 0) throw new Error('Protected census barrier exceeded its bounded window')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await protectedSpan(phase, () =>
        Promise.race([
          ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Protected census barrier exceeded its bounded window')),
              remainingMs,
            )
          }),
        ]),
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  fail(): void {
    this.#failure ??= new Error('A sibling protected proof failed; further admission is closed')
    this.#releaseBefore()
  }

  async before<T>(scope: string, observe: () => Promise<T>): Promise<T> {
    this.#scope(scope)
    try {
      const value = await protectedSpan(`census.before.observe.${scope}`, observe)
      this.#before.add(scope)
      if (this.#before.size === this.#scopes.size) this.#releaseBefore()
      await this.#wait(this.#beforeReady, `census.before.join.${scope}`)
      this.assertAdmission()
      return value
    } catch (error) {
      this.fail()
      throw error
    }
  }

  cleaned(scope: string, succeeded: boolean): void {
    this.#scope(scope)
    if (
      !succeeded ||
      [...this.#resources.values()].some(
        (resource) => resource.scope === scope && !resource.deleted,
      )
    )
      this.fail()
    this.#cleaned.add(scope)
    if (this.#cleaned.size === this.#scopes.size) this.#releaseCleanup()
  }

  async after<T>(scope: string, observe: () => Promise<T>): Promise<T> {
    this.#scope(scope)
    await this.#wait(this.#cleanupReady, `census.after.join.${scope}`)
    return protectedSpan(`census.after.observe.${scope}`, observe)
  }
}
