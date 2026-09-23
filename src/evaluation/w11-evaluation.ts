import { W11_SEMANTIC_CASES } from './w11-cases.js'
import { calibrateW11Judge } from './w11-calibration.js'
import {
  type W11EvaluationInput,
  type W11EvaluationObservation,
  type W11EvaluationResult,
  type W11EvaluationRole,
  type W11Judge,
  type W11Verdict,
  w11Scenario,
} from './w11-types.js'

export async function runW11Evaluation(
  judge: W11Judge,
  inputs: readonly W11EvaluationInput[],
  signal?: AbortSignal,
): Promise<W11EvaluationResult> {
  const calibration = await calibrateW11Judge(judge, signal)
  const expectedIds = new Set(
    W11_SEMANTIC_CASES.flatMap((item) => item.fixtures.map((fixture) => fixture.id)),
  )
  if (
    inputs.length !== expectedIds.size ||
    inputs.some((input) => !expectedIds.has(input.fixtureId)) ||
    new Set(inputs.map((input) => input.fixtureId)).size !== expectedIds.size
  )
    throw new Error('W11 evaluation requires real candidate inputs for all named fixtures')
  const fixtures = new Map(
    W11_SEMANTIC_CASES.flatMap((item) =>
      item.fixtures.map((fixture) => [fixture.id, { item, fixture }] as const),
    ),
  )
  for (const input of inputs) {
    const expected = fixtures.get(input.fixtureId)
    if (
      !expected ||
      input.caseId !== expected.item.id ||
      input.dimension !== expected.item.dimension ||
      typeof input.candidate !== 'string' ||
      input.candidate.trim().length === 0
    )
      throw new Error(`W11 evaluation input does not match fixture ${input.fixtureId}`)
  }
  const observations = (
    await Promise.all(
      inputs.map(async (input): Promise<W11EvaluationObservation[]> => {
        const expected = fixtures.get(input.fixtureId)
        if (!expected) throw new Error(`Unknown W11 fixture: ${input.fixtureId}`)
        const candidates = [
          { role: 'candidate', text: input.candidate },
          { role: 'seeded-bad', text: expected.fixture.bad },
          { role: 'trivial', text: expected.fixture.trivial },
        ] as const
        return Promise.all(
          candidates.map(async (candidate) => ({
            caseId: input.caseId,
            fixtureId: input.fixtureId,
            dimension: input.dimension,
            role: candidate.role,
            observation: await judge.judge({
              candidate: candidate.text,
              reference: expected.fixture.good,
              scenario: w11Scenario(
                `${input.fixtureId}:${candidate.role}`,
                input.caseId,
                input.caseId,
              ),
              ...(signal ? { signal } : {}),
            }),
          })),
        )
      }),
    )
  ).flat()
  const byFixture = new Map<string, W11EvaluationObservation[]>()
  for (const observation of observations) {
    const group = byFixture.get(observation.fixtureId) ?? []
    group.push(observation)
    byFixture.set(observation.fixtureId, group)
  }
  const scoreMean = (role: W11EvaluationRole): number => {
    const scores = observations
      .filter((observation) => observation.role === role)
      .map((observation) => observation.observation.score)
    return scores.reduce((sum, score) => sum + score, 0) / scores.length
  }
  const failedFixtureIds = [...byFixture.entries()]
    .filter(([, group]) => {
      const candidate = group.find((item) => item.role === 'candidate')?.observation.score
      const bad = group.find((item) => item.role === 'seeded-bad')?.observation.score
      const trivial = group.find((item) => item.role === 'trivial')?.observation.score
      return (
        candidate === undefined ||
        bad === undefined ||
        trivial === undefined ||
        !Number.isFinite(candidate) ||
        !Number.isFinite(bad) ||
        !Number.isFinite(trivial) ||
        candidate <= bad ||
        candidate <= trivial
      )
    })
    .map(([fixtureId]) => fixtureId)
  const requiredCases = expectedIds.size
  const verdict: W11Verdict = {
    status: failedFixtureIds.length === 0 ? 'passed' : 'failed',
    passedCases: requiredCases - failedFixtureIds.length,
    requiredCases,
    candidateMean: scoreMean('candidate'),
    seededBadMean: scoreMean('seeded-bad'),
    trivialMean: scoreMean('trivial'),
    failedFixtureIds,
  }
  return {
    provenance: {
      source: judge.source,
      judgeName: judge.name,
      judgeVersion: judge.version,
      fixtureCount: inputs.length,
      observationCount: observations.length,
      calibrationCount: calibration.observations.length,
    },
    calibration,
    observations,
    verdict,
  }
}
