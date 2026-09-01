import type { ConnectionId } from './ids.js'
import { isActiveRunStatus, type BraidState } from './state.js'

export type ConnectionRemovalBlockerKind =
  | 'selected'
  | 'branch'
  | 'run'
  | 'environment'
  | 'binding'
  | 'automation-rule'

export interface ConnectionRemovalBlocker {
  readonly kind: ConnectionRemovalBlockerKind
  readonly id: string
  readonly status?: string
  readonly action: string
}

export function connectionRemovalBlockers(
  state: BraidState,
  connectionId: ConnectionId,
): readonly ConnectionRemovalBlocker[] {
  const blockers: ConnectionRemovalBlocker[] = []

  if (state.selectedConnectionId === connectionId) {
    blockers.push({
      kind: 'selected',
      id: connectionId,
      action: 'Select a different connection before removing this one',
    })
  }

  for (const branch of state.branches) {
    if (branch.connectionId !== connectionId || branch.status === 'archived') continue
    blockers.push({
      kind: 'branch',
      id: branch.id,
      status: branch.status,
      action: 'Rebind or archive the branch before removing this connection',
    })
  }

  for (const run of state.runs) {
    const runConnectionId = run.connectionId ?? run.receipt.requested.connectionId
    if (runConnectionId !== connectionId) continue
    if (isProvenTerminal(run)) continue
    blockers.push({
      kind: 'run',
      id: run.id,
      status: run.status,
      action: isActiveRunStatus(run.status)
        ? 'Reconcile the active run before removing this connection'
        : 'Wait for the run to reach a proven terminal status before removing this connection',
    })
  }

  for (const environment of state.environments) {
    if (environment.connectionId !== connectionId) continue
    if (environment.lifecycle === 'expired' || environment.lifecycle === 'destroyed') continue
    blockers.push({
      kind: 'environment',
      id: environment.id,
      status: environment.lifecycle,
      action:
        'Finish environment cleanup so it is expired or destroyed before removing this connection',
    })
  }

  for (const binding of state.bindings) {
    if (binding.connectionId !== connectionId) continue
    if (binding.status === 'expired' || binding.status === 'released') continue
    blockers.push({
      kind: 'binding',
      id: binding.id,
      status: binding.status,
      action: 'Release or rebind the provider binding before removing this connection',
    })
  }

  for (const rule of state.rules) {
    if (!rule.enabled || rule.matcher.connectionId !== connectionId) continue
    blockers.push({
      kind: 'automation-rule',
      id: rule.id,
      action: 'Disable or remove the automation rule before removing this connection',
    })
  }

  return blockers
}

function isProvenTerminal(run: BraidState['runs'][number]): boolean {
  return (
    run.complete &&
    (run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled' ||
      run.status === 'aborted' ||
      run.status === 'blocked' ||
      run.status === 'expired')
  )
}
