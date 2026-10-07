import type { FeedbackTrajectory } from '@tangle-network/agent-eval'
import { harnessSupportsModel, harnessTypeSchema } from '../adapters/agent-interface/harness-runtime.js'
import { redactSensitiveText } from '../domain/redaction.js'
import { AppError } from './errors.js'
import type { ProfileSummary } from './profiles.js'

/** The analyst reasons over observations; Braid does not invent a routing score. */
export async function runnerAdviceQuestion(input: {
  readonly task: string
  readonly feedback: readonly FeedbackTrajectory[]
  readonly profiles: readonly ProfileSummary[]
}): Promise<string> {
  const task = input.task.trim()
  if (task.length === 0 || task.length > 4096)
    throw new AppError('INVALID_PARAMS', 'Runner advice requires a task of 1 to 4096 characters')
  if (input.feedback.length === 0)
    throw new AppError('RUNNER_EVIDENCE_UNAVAILABLE', 'Record task feedback before requesting runner advice')
  const candidates = input.profiles.flatMap((profile) => {
    const runner = harnessTypeSchema.safeParse(profile.runner)
    if (!runner.success || profile.model === undefined || !harnessSupportsModel(runner.data, profile.model)) return []
    return [{ profile: redactSensitiveText(profile.name, 256), runner: runner.data, model: redactSensitiveText(profile.model, 256), profileDigest: profile.digest }]
  })
  if (candidates.length === 0)
    throw new AppError('RUNNER_CANDIDATES_UNAVAILABLE', 'No compatible runner and model pair is present in the profile catalog')
  const { summarizePreferenceMemory, renderPreferenceMemoryMarkdown } = await import('@tangle-network/agent-eval')
  const recent = input.feedback.slice(-20)
  // These are explicitly attributed user observations, not independently graded trace facts.
  const observations = recent.map((trajectory) => ({
    id: trajectory.id,
    task: redactSensitiveText(trajectory.task.intent, 2048),
    tags: trajectory.tags,
    labels: trajectory.labels,
    metadata: trajectory.metadata,
  }))
  // Drop whole old records so the ledger stays valid JSON and input cost stays bounded.
  while (Buffer.byteLength(JSON.stringify(observations), 'utf8') > 24_000) {
    observations.shift()
    recent.shift()
  }
  const memory = redactSensitiveText(renderPreferenceMemoryMarkdown(
    summarizePreferenceMemory(recent, { maxEntries: 20 }),
  ), 8192)
  return [
    'Recommend a runner and model for the next task from the catalog below, or say that the evidence is insufficient.',
    'Use the frozen run as primary evidence and cite it. Attribute the separate feedback ledger to the user by trajectory id; it is user judgment, not an independently verified outcome.',
    'Account for task relevance, profile differences, model differences, unknown cost and missing comparisons. Completion is not correctness. Do not claim causal superiority from observational feedback or invent a success rate.',
    'Catalog membership establishes a configured candidate, not live provider availability. Say what must be checked before dispatch. Do not change the runner or profile.',
    'Return a concise recommendation, the evidence for it, uncertainty, and the smallest useful comparison if no choice is supported.',
    `Next task: ${redactSensitiveText(task, 4096)}`,
    `Catalog candidates: ${JSON.stringify(candidates.slice(0, 40))}`,
    `Recorded user lessons:\n${memory}`,
    `User feedback ledger, latest ${recent.length} of ${input.feedback.length} records (task text bounded to 2048 characters):\n${JSON.stringify(observations)}`,
  ].join('\n\n')
}
