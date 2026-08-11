import type { BraidViewModel, EnvironmentView, RunView } from '../shared/models.js'

export interface ExecutionTargetView {
  readonly source: 'profile' | 'run'
  readonly runId?: string
  readonly profileName: string
  readonly profileDigest?: string
  readonly runner: string
  readonly model: string
  readonly effort?: string
  readonly maxOutputTokens?: number
  readonly connection: string
  readonly connectionId?: string
  readonly environment?: EnvironmentView
}

/** Selects one coherent execution identity without combining two profile revisions. */
export function executionTargetFor(
  view: BraidViewModel,
  runId: string | undefined = view.activeRunId,
): ExecutionTargetView {
  const run =
    runId === undefined ? undefined : view.runs.find((candidate) => candidate.id === runId)
  return run === undefined ? profileTarget(view) : runTarget(view, run)
}

function profileTarget(view: BraidViewModel): ExecutionTargetView {
  return Object.freeze({
    source: 'profile',
    profileName: view.profileName,
    ...(view.profileDigest === undefined ? {} : { profileDigest: view.profileDigest }),
    runner: view.runner,
    model: view.model,
    ...(view.effort === undefined ? {} : { effort: view.effort }),
    ...(view.maxOutputTokens === undefined ? {} : { maxOutputTokens: view.maxOutputTokens }),
    connection: view.connection,
  })
}

function runTarget(view: BraidViewModel, run: RunView): ExecutionTargetView {
  const environment =
    run.environmentId === undefined
      ? undefined
      : view.environments.find((candidate) => candidate.id === run.environmentId)
  return Object.freeze({
    source: 'run',
    runId: run.id,
    profileName: run.profileName ?? view.profileName,
    ...(run.profileDigest === undefined ? {} : { profileDigest: run.profileDigest }),
    runner: run.runner ?? view.runner,
    model: run.model ?? run.usage?.model ?? view.model,
    ...(run.effort === undefined ? {} : { effort: run.effort }),
    ...(run.maxOutputTokens === undefined ? {} : { maxOutputTokens: run.maxOutputTokens }),
    connection: run.connection ?? run.connectionId ?? 'not connected',
    ...(run.connectionId === undefined ? {} : { connectionId: run.connectionId }),
    ...(environment === undefined ? {} : { environment }),
  })
}
