import { semanticEvalMeasurements } from '../../dist/eval/release-markers.js'
import { runSemanticEvaluation } from '../../dist/eval/runner.js'
import { prepareEvalCandidate } from './candidate.mjs'

const repository = new URL('../../', import.meta.url).pathname
const candidate = await prepareEvalCandidate(repository)
let result
try {
  result = await runSemanticEvaluation({ env: candidate.environment })
} finally {
  await candidate.cleanup()
}
const summary = {
  status: result.record.status,
  releaseAdmissible: result.record.releaseAdmissible,
  outputDir: result.outputDir,
  pilot: result.record.pilot,
  calibration: {
    passed: result.record.calibration.passed,
    pairedExamples: result.record.calibration.pairedExamples,
    goodPreferred: result.record.calibration.goodPreferred,
    minimumGoodPreferred: result.record.calibration.minimumGoodPreferred,
    ties: result.record.calibration.ties,
    reversals: result.record.calibration.reversals,
    perCategory: result.record.calibration.perCategory,
  },
  cases: result.record.cases.map((entry) => ({
    id: entry.id,
    result: entry.result,
    passedFixtures: entry.passedFixtures,
    failedFixtures: entry.failedFixtures,
    productFailures: entry.productFailures,
    disagreements: entry.disagreements,
  })),
  artifactHash: result.record.artifactHash,
}
process.stdout.write(`${JSON.stringify(summary)}\n`)
const reason = result.record.releaseFailureReasons.join('; ') || result.record.unavailableReason
process.stdout.write(
  `BRAID_RELEASE_RESULT_JSON=${JSON.stringify({
    status: result.record.status,
    ...(reason === null || reason.length === 0 ? {} : { reason }),
  })}\n`,
)
if (result.record.status === 'passed' && result.record.releaseAdmissible === true) {
  process.stdout.write(
    `BRAID_RELEASE_MEASUREMENTS_JSON=${JSON.stringify({
      measurements: semanticEvalMeasurements(result.record),
    })}\n`,
  )
} else {
  process.exitCode = 1
}
