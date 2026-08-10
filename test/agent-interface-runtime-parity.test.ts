import assert from 'node:assert/strict'
import test from 'node:test'
import * as root from '@tangle-network/agent-interface'
import {
  harnessHonorsEffort,
  harnessHonorsModel,
  harnessHonorsSelectors,
  harnessReasoningEfforts,
  harnessSupportsModel,
  harnessTypeSchema,
  preferredHarnessForModel,
  reasoningEffortsFor,
  snapHarnessToModel,
  snapModelToHarness,
} from '../src/adapters/agent-interface/harness-runtime.js'
import {
  InteractionRequestSchema,
  InteractionResponseCommandSchema,
  InteractionResponseSchema,
  interactionRequestDigest,
  interactionResponseCommandDigest,
  permissionAnswerSpec,
  validateInteractionResponse,
} from '../src/adapters/agent-interface/interaction-runtime.js'
import { agentInterfaceModuleUrl } from '../src/adapters/agent-interface/module-url.js'
import {
  agentProfileSchema,
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
  canonicalCandidateJson,
  DEFAULT_CLOUD_AGENT_PROFILE_SECURITY_POLICY,
  defineAgentProfile,
  diffAgentProfiles,
  loadAgentEnvironmentCapabilitiesSchema,
  mergeAgentProfiles,
  sha256Bytes,
  snapshotAgentProfile,
  validateAgentProfileSecurity,
} from '../src/adapters/agent-interface/profile-runtime.js'

test('narrow Agent Interface modules retain exact root-export behavior', async () => {
  const exports = [
    [agentProfileSchema, root.agentProfileSchema],
    [canonicalAgentProfileDigest, root.canonicalAgentProfileDigest],
    [canonicalCandidateDigest, root.canonicalCandidateDigest],
    [canonicalCandidateJson, root.canonicalCandidateJson],
    [DEFAULT_CLOUD_AGENT_PROFILE_SECURITY_POLICY, root.DEFAULT_CLOUD_AGENT_PROFILE_SECURITY_POLICY],
    [defineAgentProfile, root.defineAgentProfile],
    [diffAgentProfiles, root.diffAgentProfiles],
    [mergeAgentProfiles, root.mergeAgentProfiles],
    [sha256Bytes, root.sha256Bytes],
    [snapshotAgentProfile, root.snapshotAgentProfile],
    [validateAgentProfileSecurity, root.validateAgentProfileSecurity],
    [harnessHonorsEffort, root.harnessHonorsEffort],
    [harnessHonorsModel, root.harnessHonorsModel],
    [harnessHonorsSelectors, root.harnessHonorsSelectors],
    [harnessReasoningEfforts, root.harnessReasoningEfforts],
    [harnessSupportsModel, root.harnessSupportsModel],
    [harnessTypeSchema, root.harnessTypeSchema],
    [preferredHarnessForModel, root.preferredHarnessForModel],
    [reasoningEffortsFor, root.reasoningEffortsFor],
    [snapHarnessToModel, root.snapHarnessToModel],
    [snapModelToHarness, root.snapModelToHarness],
    [InteractionRequestSchema, root.InteractionRequestSchema],
    [InteractionResponseCommandSchema, root.InteractionResponseCommandSchema],
    [InteractionResponseSchema, root.InteractionResponseSchema],
    [interactionRequestDigest, root.interactionRequestDigest],
    [interactionResponseCommandDigest, root.interactionResponseCommandDigest],
    [permissionAnswerSpec, root.permissionAnswerSpec],
    [validateInteractionResponse, root.validateInteractionResponse],
  ] as const

  for (const [narrow, canonical] of exports) assert.equal(narrow, canonical)
  assert.equal(
    await loadAgentEnvironmentCapabilitiesSchema(),
    root.AgentEnvironmentCapabilitiesSchema,
  )

  const profile = defineAgentProfile({
    name: 'narrow export parity',
    harness: 'pi',
    model: { default: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex' },
  })
  assert.deepEqual(snapshotAgentProfile(profile), root.snapshotAgentProfile(profile))
  assert.equal(canonicalAgentProfileDigest(profile), root.canonicalAgentProfileDigest(profile))
  assert.equal(harnessSupportsModel('pi', 'openai-codex/gpt-5.6-luna'), true)
})

test('internal module URL adapter rejects path escape', () => {
  assert.match(agentInterfaceModuleUrl('profile-schema.js'), /profile-schema\.js$/u)
  assert.throws(() => agentInterfaceModuleUrl('../package.json'), /module name is invalid/u)
  assert.throws(() => agentInterfaceModuleUrl('PROFILE-SCHEMA.js'), /module name is invalid/u)
})
