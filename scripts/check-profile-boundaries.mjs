import { readFile } from 'node:fs/promises'

const selectionPath = new URL('../src/profile/run-selection.ts', import.meta.url)
const validationPath = new URL('../src/profile/profile-validation.ts', import.meta.url)
const selection = await readFile(selectionPath, 'utf8')
const validation = await readFile(validationPath, 'utf8')

const violations = []
for (const token of [
  'interface BraidProfile',
  'type BraidProfile',
  'runnerModelMatrix',
  'modelCompatibility',
  'HARNESS_MODELS',
]) {
  if (selection.includes(token) || validation.includes(token)) {
    violations.push(`profile code contains a Braid-owned schema or compatibility table: ${token}`)
  }
}

for (const helper of [
  'harnessHonorsEffort',
  'harnessHonorsModel',
  'harnessSupportsModel',
  'preferredHarnessForModel',
  'reasoningEffortsFor',
  'reasoningLadder',
  'snapModelToHarness',
]) {
  if (!selection.includes(helper))
    violations.push(`selection does not use canonical helper ${helper}`)
}

for (const helper of [
  'agentProfileSchema',
  'canonicalAgentProfileDigest',
  'snapshotAgentProfile',
  'validateAgentProfileSecurity',
]) {
  if (!validation.includes(helper))
    violations.push(`validation does not use agent-interface ${helper}`)
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`)
  process.exit(1)
}

process.stdout.write(
  'Profile boundaries: canonical schema/helpers only; no local runner/model matrix\n',
)
