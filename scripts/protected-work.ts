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
  | 'reservationWaits'
  | 'workBarriers'
const COUNTERS: readonly Counter[] = [
  'polls',
  'frameRequests',
  'stateRequests',
  'parentRequests',
  'parentCreates',
  'censusBarriers',
  'reservationWaits',
  'workBarriers',
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
    readonly pipeline = false,
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
      monotonicClockOriginMs: this.startedMs,
      completedAt: new Date().toISOString(),
      wallMs: performance.now() - this.startedMs,
      overlap: this.pipeline ? 'epoch-pipeline' : this.overlap ? 'post-canary' : 'off',
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
          'Wrapped proof-parent Sandbox.fetch in stress, multirun and native LIVE-08; wrapper re-entry counted',
        parentCreates:
          'Actual proof-parent POST /v1/sandboxes; excludes packed children and fork allocations',
        fullSandboxCreateRequests: null,
        packedChildRequests: null,
        unwrappedTransportRequests: null,
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
  if (!['off', 'post-canary', 'epoch-pipeline'].includes(flag) || !['0', '1'].includes(counters))
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
  return new ProtectedWork(
    flag === 'post-canary' && selected,
    rollout,
    bucket,
    flag === 'epoch-pipeline' && selected,
  )
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
    {
      readonly scope: string
      readonly runId: string
      readonly admittedMs: number
      deletedMs: number | null
      deleted: boolean
    }
  >()
  readonly #workReady = new Map<string, Promise<void>>()
  readonly #releaseWork = new Map<string, () => void>()
  readonly #reservations = new Map<string, number>()
  readonly #budgetWaiters = new Set<() => void>()
  #reservedPeak = 0
  #observedPeak = 0
  #pairPending = false
  #pairReservation: Promise<void> | undefined
  readonly #caseWork = new Map<string, { readonly startedMs: number; finishedMs: number | null }>()

  constructor(
    scopes: readonly string[],
    readonly resourceBudget?: number,
  ) {
    this.#scopes = new Set(scopes)
    if (this.#scopes.size !== scopes.length || scopes.length === 0)
      throw new Error('Proof window scope identities must be unique')
    if (resourceBudget !== undefined && resourceBudget !== 4)
      throw new Error('Protected pipeline requires the fixed four-resource budget')
    for (const scope of scopes)
      this.#workReady.set(scope, new Promise((resolve) => this.#releaseWork.set(scope, resolve)))
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
    if (this.#before.size !== this.#scopes.size)
      throw new Error('Protected admission preceded an independent before observation')
  }

  startedWork(scope: string): void {
    this.#scope(scope)
    if (this.#caseWork.has(scope)) throw new Error('Duplicate protected case execution')
    this.#caseWork.set(scope, { startedMs: performance.now(), finishedMs: null })
  }

  finishedWork(scope: string): void {
    this.#scope(scope)
    const work = this.#caseWork.get(scope)
    if (work !== undefined) work.finishedMs ??= performance.now()
  }

  /** Reserve the complete case allocation before admitting its first resource. */
  async reserve(scope: string, slots: number, afterScope?: string): Promise<void> {
    if (this.resourceBudget !== undefined && ['stress-1', 'stress-2'].includes(scope)) {
      if (slots !== 1 || afterScope !== 'stress-0')
        throw new Error('Stress workers require an atomic post-canary pair')
      this.#pairReservation ??= this.#reserve(
        [
          { scope: 'stress-1', slots: 1 },
          { scope: 'stress-2', slots: 1 },
        ],
        afterScope,
      )
      return this.#pairReservation
    }
    return this.#reserve([{ scope, slots }], afterScope)
  }

  async #reserve(
    cases: readonly { scope: string; slots: number }[],
    afterScope?: string,
  ): Promise<void> {
    for (const { scope } of cases) this.#scope(scope)
    const scope = cases.map((entry) => entry.scope).join('+')
    const slots = cases.reduce((sum, entry) => sum + entry.slots, 0)
    const pair = cases.length === 2
    if (this.resourceBudget === undefined) return
    if (!Number.isSafeInteger(slots) || slots < 1 || slots > this.resourceBudget)
      throw new Error('Invalid protected case resource reservation')
    if (afterScope !== undefined) {
      this.#scope(afterScope)
      await this.#wait(this.#workReady.get(afterScope)!, `work.join.${scope}.${afterScope}`)
    }
    this.assertAdmission()
    if (cases.some((entry) => this.#reservations.has(entry.scope)))
      throw new Error('Duplicate protected case reservation')
    while (
      (!pair && this.#pairPending) ||
      [...this.#reservations.values()].reduce((sum, value) => sum + value, 0) + slots >
        this.resourceBudget
    ) {
      let wake!: () => void
      const ready = new Promise<void>((resolve) => {
        wake = resolve
      })
      this.#budgetWaiters.add(wake)
      try {
        await this.#wait(ready, `resource.join.${scope}`)
      } finally {
        this.#budgetWaiters.delete(wake)
      }
      this.assertAdmission()
    }
    for (const entry of cases) this.#reservations.set(entry.scope, entry.slots)
    if (pair) {
      this.#pairPending = false
      for (const wake of this.#budgetWaiters) wake()
    }
    this.#reservedPeak = Math.max(
      this.#reservedPeak,
      [...this.#reservations.values()].reduce((sum, value) => sum + value, 0),
    )
  }

  admitted(scope: string, runId: string, environmentId: string): void {
    this.#scope(scope)
    if (!runId || !environmentId) throw new Error('Exact resource admission is incomplete')
    const prior = this.#resources.get(environmentId)
    if (prior !== undefined) {
      if (prior.scope !== scope || prior.runId !== runId)
        throw new Error('Protected scopes reused an environment identity')
      return
    }
    if (this.#cleaned.has(scope)) throw new Error('Resource admission followed scope cleanup')
    if (this.resourceBudget !== undefined) {
      const owned = [...this.#resources.values()].filter(
        (resource) => resource.scope === scope,
      ).length
      if (!this.#reservations.has(scope) || owned >= this.#reservations.get(scope)!)
        throw new Error('Protected case exceeded its resource reservation')
    }
    this.#resources.set(environmentId, {
      scope,
      runId,
      admittedMs: performance.now(),
      deletedMs: null,
      deleted: false,
    })
    this.#observedPeak = Math.max(
      this.#observedPeak,
      [...this.#resources.values()].filter((resource) => !resource.deleted).length,
    )
  }

  deleted(scope: string, environmentId: string): void {
    this.#scope(scope)
    const admission = this.#resources.get(environmentId)
    if (admission === undefined || admission.scope !== scope)
      throw new Error('Deletion receipt is not bound to this proof admission')
    admission.deleted = true
    admission.deletedMs ??= performance.now()
  }

  snapshot() {
    const first = [...this.#resources.values()].find((resource) => resource.scope === 'stress-1')
    const second = [...this.#resources.values()].find((resource) => resource.scope === 'stress-2')
    const pairOverlapMs =
      first?.deletedMs != null && second?.deletedMs != null
        ? Math.max(
            0,
            Math.min(first.deletedMs, second.deletedMs) -
              Math.max(first.admittedMs, second.admittedMs),
          )
        : null
    const firstWork = this.#caseWork.get('stress-1')
    const secondWork = this.#caseWork.get('stress-2')
    const pairWorkOverlapMs =
      firstWork?.finishedMs != null && secondWork?.finishedMs != null
        ? Math.max(
            0,
            Math.min(firstWork.finishedMs, secondWork.finishedMs) -
              Math.max(firstWork.startedMs, secondWork.startedMs),
          )
        : null
    return {
      scopes: [...this.#scopes],
      beforeObserved: [...this.#before],
      cleanupSettled: [...this.#cleaned],
      failure: this.#failure !== undefined,
      maximumWaitMs: 900_000,
      resourceBudget: this.resourceBudget ?? null,
      reservedPeak: this.resourceBudget === undefined ? null : this.#reservedPeak,
      observedIdentifiedResourcePeak: this.resourceBudget === undefined ? null : this.#observedPeak,
      stressPairIdentifiedResourceOverlapMs:
        this.resourceBudget === undefined ? null : pairOverlapMs,
      stressPairWorkOverlapMs: this.resourceBudget === undefined ? null : pairWorkOverlapMs,
      caseWork: [...this.#caseWork].map(([scope, work]) => ({ scope, ...work })),
      caseWorkCoverage:
        'First send dispatch through proof work and assertions; excludes cleanup and census joins',
      exactResources: [...this.#resources].map(([environmentId, admission]) => ({
        environmentId,
        ...admission,
      })),
    }
  }

  async #wait(ready: Promise<void>, phase: string): Promise<void> {
    if (phase.startsWith('census.')) countProtectedWork('censusBarriers')
    else if (phase.startsWith('resource.')) countProtectedWork('reservationWaits')
    else if (phase.startsWith('work.')) countProtectedWork('workBarriers')
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
    for (const wake of this.#budgetWaiters) wake()
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
    if (
      scope === 'stress-0' &&
      this.resourceBudget !== undefined &&
      this.#scopes.has('stress-1') &&
      this.#scopes.has('stress-2')
    )
      this.#pairPending = true
    const exact = [...this.#resources.values()].every(
      (resource) => resource.scope !== scope || resource.deleted,
    )
    if (exact) this.#reservations.delete(scope)
    this.#releaseWork.get(scope)!()
    for (const wake of this.#budgetWaiters) wake()
    if (this.#cleaned.size === this.#scopes.size) this.#releaseCleanup()
  }

  async after<T>(scope: string, observe: () => Promise<T>): Promise<T> {
    this.#scope(scope)
    await this.#wait(this.#cleanupReady, `census.after.join.${scope}`)
    return protectedSpan(`census.after.observe.${scope}`, observe)
  }
}
