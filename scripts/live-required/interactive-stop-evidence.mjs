import assert from 'node:assert/strict'

import * as agentInterface from '@tangle-network/agent-interface'

import { countProtectedWork } from '../proof-tools.mjs'
import { assertSameInteractiveRef } from './tangle-sandbox-interactive-continuity.mjs'
import { sleep } from '../live-bridge/process.mjs'
import { safeMessage } from './contracts.mjs'
import { observeSandboxInventory } from './provider-observation.mjs'
import {
  interactiveResourceName,
  isOwnedInteractiveResource,
  sameNameInteractiveResources,
} from './interactive-resource-ownership.mjs'

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

/**
 * When Braid's stop already released the retained environment, the stopped-sandbox
 * observation cannot resolve it. The release is confirmed cleanup only when the
 * sandbox itself is gone AND no owned interactive resource with the proof's exact
 * name remains in the account census; anything else is a real cleanup failure.
 */
export async function releasedByStopCleanup(client, controlRef, runId, timeoutMs) {
  const environmentId = controlRef.environmentId
  let absent = false
  try {
    const box = await client.get(environmentId)
    absent = box === null || box === undefined || box.id !== environmentId
  } catch {
    absent = true
  }
  if (!absent) return undefined
  const expectedName = interactiveResourceName(runId)
  const census = await observeSandboxInventory(client, {
    timeoutMs,
    label: 'released Sandbox census',
  })
  const remaining = sameNameInteractiveResources(census, expectedName, (resource) =>
    isOwnedInteractiveResource(resource, expectedName),
  )
  if (remaining.length !== 0) return undefined
  return {
    afterStop: { releasedByStop: true, environmentId },
    cleanup: {
      confirmed: true,
      removedIds: [environmentId],
      remainingIds: [],
      matchedCount: 1,
      releasedByStop: true,
    },
  }
}

export function assertInteractiveOwnedResourceCleanup(cleanup, expectedEnvironmentId) {
  assert.equal(cleanup?.confirmed, true, 'owned Sandbox cleanup was not confirmed')
  assert.ok(
    Array.isArray(cleanup?.removedIds) && cleanup.removedIds.includes(expectedEnvironmentId),
    'owned Sandbox cleanup omitted the exact resource',
  )
  assert.equal(cleanup?.remainingIds?.length, 0, 'owned Sandbox cleanup left a resource behind')
  assert.equal(
    cleanup?.matchedCount,
    1,
    `owned Sandbox cleanup found ${cleanup?.matchedCount ?? 'an unknown number of'} resources; expected one`,
  )
  return cleanup
}

export async function attemptCleanup(errors, label, operation) {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    errors.push(cleanupFailure(label, error))
    return { ok: false, value: undefined }
  }
}

export function cleanupFailure(label, error) {
  return new Error(`${label}: ${safeMessage(error)}`, { cause: error })
}
