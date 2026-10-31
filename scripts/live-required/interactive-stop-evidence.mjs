import assert from 'node:assert/strict'

import * as agentInterface from '@tangle-network/agent-interface'

import { countProtectedWork } from '../proof-tools.mjs'
import { assertSameInteractiveRef } from './tangle-sandbox-interactive-continuity.mjs'
import { sleep } from '../live-bridge/process.mjs'

/**
 * Proves the provider ran exactly the one interactive process Braid started, and that Braid's stop
 * ended it. Interactive sessions use the interactive-control API, so `session.runs()` (the headless
 * execution list) must stay empty; the interactive status tombstone carries the exact identity,
 * and when the platform no longer serves a tombstone after release, the stop receipt's own
 * provider-observed exit (captured while the session existed) carries it instead.
 */
export async function interactiveStopProviderEvidence({
  box,
  controlRef,
  sessionRef,
  dispatchStop,
  timeoutMs,
  label = 'LIVE-08 provider interactive execution',
  pause = sleep,
  now = () => performance.now(),
}) {
  assert.equal(box?.id, controlRef.environmentId, `${label} did not resolve the exact Sandbox`)
  assert.equal(
    sessionRef?.run?.executionId,
    controlRef.executionId,
    `${label} admission ref differs from the Braid control reference`,
  )
  const session = box.session(controlRef.sessionId)
  const handle = session.interactive({ ref: sessionRef })
  // Observe the provider's terminal status and the headless execution list WHILE
  // the stop is dispatched: Braid holds the exited state briefly before it
  // releases the environment, so both reads complete before the sandbox is gone.
  const observe = observeProviderExit(handle, sessionRef, controlRef, timeoutMs, label, pause, now)
  const headless = session.runs().catch((error) => error)
  const stop = await dispatchStop()
  const exited = await observe
  const headlessExecutions = await headless
  if (headlessExecutions instanceof Error) throw headlessExecutions
  assert.ok(Array.isArray(headlessExecutions), `${label} did not return the execution list`)
  assert.equal(
    headlessExecutions.length,
    0,
    `${label} found ${String(headlessExecutions.length)} headless executions beside the interactive process`,
  )
  assert.equal(exited.reason, 'stopped', `${label} did not end through the exact stop request`)
  return {
    stop,
    providerExecution: {
      matched: true,
      providerObserved: true,
      source: 'interactive-status',
      state: exited.state,
      reason: exited.reason,
      endedAt: exited.endedAt,
      executionId: exited.ref.run.executionId,
      incarnationId: exited.ref.incarnationId,
      headlessExecutionCount: 0,
    },
  }
}

/**
 * Observes the provider's exited status while the environment still exists. Braid's interactive
 * stop holds the terminal state briefly before releasing the environment, so an observer polling
 * alongside the stop request sees the exit; polling after the stop returns may find the sandbox
 * already released and the status unreadable.
 */
export function observeProviderExit(handle, sessionRef, controlRef, timeoutMs, label, pause, now) {
  const deadline = now() + timeoutMs
  return (async () => {
    for (;;) {
      countProtectedWork('polls')
      const status = await handle.status().catch(() => undefined)
      if (status) {
        assertSameInteractiveRef(agentInterface, sessionRef, status.ref, `${label} status`)
        if (status.state === 'exited') {
          assert.equal(
            status.ref.run.executionId,
            controlRef.executionId,
            `${label} exit execution`,
          )
          return status
        }
      }
      if (now() >= deadline)
        throw new Error(`${label} stopped status timed out after ${timeoutMs}ms`)
      await pause(250)
    }
  })()
}
