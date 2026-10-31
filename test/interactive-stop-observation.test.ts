import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROVIDER_EXIT_HOLD_MS,
  PROVIDER_EXIT_POLL_MS,
  PROVIDER_EXIT_WAIT_MS,
} from '../src/adapters/runtime/tangle-retained-interactive-execution.js'
import { pathToFileURL } from 'node:url'

// The live proof module is a release helper without a product declaration; load it
// from the repository (tests run with the repository as the working directory).
interface StopEvidence {
  readonly stop: { readonly acknowledgement: { readonly outcome: string } }
  readonly providerExecution: {
    readonly providerObserved: boolean
    readonly source: string
    readonly state: string
    readonly reason: string
    readonly endedAt: string
    readonly executionId: string
    readonly incarnationId: string
    readonly headlessExecutionCount: number
  }
}
interface ExitStatus {
  readonly state: string
  readonly reason: string
  readonly endedAt: string
  readonly ref: { readonly run: { readonly executionId: string }; readonly incarnationId: string }
}
interface CleanupModule {
  readonly cleanupFailure: (label: string, error: unknown) => Error
  readonly releasedByStopCleanup: (
    client: unknown,
    controlRef: { readonly environmentId: string },
    runId: string,
    timeoutMs: number,
  ) => Promise<{ afterStop: unknown; cleanup: Record<string, unknown> } | undefined>
}
interface StopEvidenceModule {
  readonly interactiveStopProviderEvidence: (input: {
    readonly box: unknown
    readonly controlRef: unknown
    readonly sessionRef: unknown
    readonly dispatchStop: () => Promise<{ readonly acknowledgement: { readonly outcome: string } }>
    readonly timeoutMs: number
  }) => Promise<StopEvidence>
  readonly observeProviderExit: (
    handle: unknown,
    sessionRef: unknown,
    controlRef: unknown,
    timeoutMs: number,
    label: string,
    pause: (ms: number) => Promise<void>,
    now: () => number,
  ) => Promise<ExitStatus>
}
// The live proof module is a release helper without a product declaration; load it
// from the repository (tests run with the repository as the working directory).
const stopEvidenceModule = (await import(
  pathToFileURL(`${process.cwd()}/scripts/live-required/interactive-stop-evidence.mjs`).href
)) as unknown as StopEvidenceModule & CleanupModule
const { interactiveStopProviderEvidence, observeProviderExit } = stopEvidenceModule

const controlRef = { environmentId: 'env-1', executionId: 'exec-1', sessionId: 'sess-1' }
const sessionRef = {
  run: { executionId: 'exec-1', environmentId: 'env-1', sessionId: 'sess-1' },
  sessionId: 'sess-1',
  incarnationId: 'inc-1',
}

/**
 * A provider double with the production failure shape: the session reports
 * running until the stop lands, reports exited while Braid holds the terminal
 * state, and every read after release fails as if the sandbox were deleted.
 */
function providerDouble({ holdMs, releaseAfter }: { holdMs: number; releaseAfter: number }) {
  const state = { stoppedAt: 0 as number, released: false, reads: 0 }
  const handle = {
    ref: sessionRef,
    status: async () => {
      state.reads += 1
      if (state.released) throw new Error('sandbox deleted')
      if (state.stoppedAt === 0) return { state: 'running', ref: sessionRef }
      if (Date.now() - state.stoppedAt > holdMs) {
        state.released = true
        throw new Error('sandbox deleted')
      }
      return {
        state: 'exited',
        reason: 'stopped',
        endedAt: '2026-10-31T00:00:00.000Z',
        ref: { ...sessionRef, incarnationId: sessionRef.incarnationId },
      }
    },
  }
  const session = {
    interactive: () => handle,
    runs: async () => {
      if (state.released) throw new Error('sandbox deleted')
      return []
    },
  }
  const box = { id: 'env-1', session: () => session }
  const dispatchStop = async () => {
    await new Promise((resolve) => setTimeout(resolve, releaseAfter))
    state.stoppedAt = Date.now()
    // Braid releases the environment once the hold ends.
    setTimeout(() => {
      state.released = true
    }, holdMs + 25)
    return { acknowledgement: { outcome: 'accepted' } }
  }
  return { box, dispatchStop, state }
}

test('the provider-exit wait budget stays bounded and observable', () => {
  assert.ok(PROVIDER_EXIT_WAIT_MS <= 20_000, 'cancel cleanup must stay bounded')
  assert.ok(PROVIDER_EXIT_HOLD_MS >= 2_000, 'the hold must cover concurrent observer polls')
  assert.ok(PROVIDER_EXIT_POLL_MS <= 500)
})

test('the stop observer reads the exited identity while the environment is held', async () => {
  const { box, dispatchStop } = providerDouble({ holdMs: PROVIDER_EXIT_HOLD_MS, releaseAfter: 30 })
  const { stop, providerExecution } = await interactiveStopProviderEvidence({
    box: box as never,
    controlRef,
    sessionRef: sessionRef as never,
    dispatchStop,
    timeoutMs: 10_000,
  })
  assert.equal(stop.acknowledgement.outcome, 'accepted')
  assert.equal(providerExecution.providerObserved, true)
  assert.equal(providerExecution.source, 'interactive-status')
  assert.equal(providerExecution.state, 'exited')
  assert.equal(providerExecution.reason, 'stopped')
  assert.equal(providerExecution.executionId, 'exec-1')
  assert.equal(providerExecution.incarnationId, 'inc-1')
  assert.equal(providerExecution.headlessExecutionCount, 0)
})

test('observeProviderExit fails closed when the provider never reports exited', async () => {
  const handle = {
    ref: sessionRef,
    status: async () => ({ state: 'running', ref: sessionRef }),
  }
  await assert.rejects(
    observeProviderExit(
      handle,
      sessionRef as never,
      controlRef as never,
      300,
      'test-observer',
      (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      () => Date.now(),
    ),
    /timed out after 300ms/u,
  )
})

test('observeProviderExit rejects a status that names a different incarnation', async () => {
  const handle = {
    ref: sessionRef,
    status: async () => ({
      state: 'exited',
      reason: 'stopped',
      endedAt: '2026-10-31T00:00:00.000Z',
      ref: { ...sessionRef, incarnationId: 'inc-OTHER' },
    }),
  }
  await assert.rejects(
    observeProviderExit(
      handle,
      sessionRef as never,
      controlRef as never,
      1_000,
      'test-identity',
      (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      () => Date.now(),
    ),
    (error: unknown) =>
      error instanceof Error && /status|incarnation|identity/iu.test(error.message),
  )
})

test('moved cleanup helpers stay callable (a missing import fails here, not in production)', async () => {
  const failure = stopEvidenceModule.cleanupFailure('label', new Error('inner'))
  assert.match(failure.message, /label: inner/u)
  const absentClient = {
    get: async () => null,
    list: async () => [],
  }
  const released = await stopEvidenceModule.releasedByStopCleanup(
    absentClient,
    { environmentId: 'env-gone' },
    'run-x',
    2_000,
  )
  assert.equal(released?.cleanup.confirmed, true)
  const stillThere = { get: async () => ({ id: 'env-gone' }), list: async () => [] }
  assert.equal(
    await stopEvidenceModule.releasedByStopCleanup(
      stillThere,
      { environmentId: 'env-gone' },
      'run-x',
      2_000,
    ),
    undefined,
  )
})
