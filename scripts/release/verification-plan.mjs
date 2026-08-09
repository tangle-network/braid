import { createHash } from 'node:crypto'
import { relative } from 'node:path'

import { RELEASE_COMMANDS, REQUIRED_CHECKS } from '../release-check-catalog.mjs'
import { assert } from '../release-evidence.mjs'
import { readRegularFileNoFollow } from '../release-files.mjs'
import { readRequirementIds } from './build-identity.mjs'
import { filesBelow, uniqueBy } from './verification-support.mjs'

export async function buildDocumentationPlan({ repository, docsRoot }) {
  const docFiles = (await filesBelow(docsRoot)).filter((path) => path.endsWith('.md'))
  const requirementIds = await readRequirementIds(repository)
  assert(requirementIds.length > 0, 'No requirement identifiers found in docs')
  const specificationDigests = []
  for (const path of docFiles) {
    const text = (await readRegularFileNoFollow(path)).toString('utf8')
    specificationDigests.push({
      path: relative(repository, path),
      sha256: createHash('sha256').update(text).digest('hex'),
    })
  }
  return {
    requirements: new Set(requirementIds),
    specificationDigests,
  }
}

export function buildEvidencePlan(evidence, requirements) {
  const checks = uniqueBy(evidence.checks, 'id', 'check')
  const artifacts = uniqueBy(evidence.artifacts, 'id', 'artifact')
  const mappings = new Map(Object.entries(evidence.requirements))
  const allowedCheckIds = new Set([...REQUIRED_CHECKS.keys(), ...requirements])
  const allowedCommands = new Map(
    [...RELEASE_COMMANDS.values()].map((check) => [check.command, check.category]),
  )
  return { checks, artifacts, mappings, allowedCheckIds, allowedCommands }
}
