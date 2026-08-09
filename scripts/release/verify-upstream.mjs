import { resolve } from 'node:path'

import { writeJsonAtomic } from './atomic-storage.mjs'
import { collectUpstreamEvidence } from './upstream-evidence.mjs'

const repository = resolve(new URL('../../', import.meta.url).pathname)
const artifactRootValue = process.env.BRAID_RELEASE_ARTIFACT_ROOT
if (!artifactRootValue) throw new Error('BRAID_RELEASE_ARTIFACT_ROOT is required')
const outputPath = resolve(artifactRootValue, 'upstream', 'evidence.json')

function safeReason(error) {
  let safe = ''
  for (const character of error instanceof Error ? error.message : String(error)) {
    const codePoint = character.codePointAt(0) ?? 0
    safe += codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
    if (safe.length >= 1_024) break
  }
  return safe
}

let evidence
try {
  evidence = await collectUpstreamEvidence({ repository })
} catch (error) {
  evidence = {
    schema: 'braid.upstream-evidence.v1',
    collectedAt: new Date().toISOString(),
    packages: {},
    requirements: [],
    measurements: [],
    failures: [safeReason(error)],
  }
}
await writeJsonAtomic(outputPath, evidence)

if (evidence.failures.length === 0) {
  process.stdout.write('BRAID_RELEASE_RESULT_JSON={"status":"passed"}\n')
  process.stdout.write(
    `BRAID_RELEASE_MEASUREMENTS_JSON=${JSON.stringify({ measurements: evidence.measurements })}\n`,
  )
} else {
  const reason = `${evidence.failures.length} owning-repository requirement result(s) are unavailable`
  process.stderr.write(`${reason}; see ${outputPath}\n`)
  process.stdout.write(
    `BRAID_RELEASE_RESULT_JSON=${JSON.stringify({ status: 'unavailable', reason })}\n`,
  )
  process.exitCode = 2
}
