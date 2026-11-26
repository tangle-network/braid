import type { AgentProfile } from '@tangle-network/agent-interface'
import { defineAgentProfile } from '@tangle-network/agent-interface/profile'

/** The skill the offline learning walkthrough's agent acts on. */
export const LEARNING_FIXTURE_SKILL = 'tidy'

/**
 * The profile the offline learning walkthrough starts from: one inline skill
 * the agent never uses, so removing it is a compression candidate.
 */
export const LEARNING_FIXTURE_PROFILE: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Learning walkthrough',
  description: 'An invented profile for the offline learning walkthrough',
  harness: 'pi',
  // The deterministic fixture model, so the walkthrough can send without a connection.
  model: { default: 'fixture/deterministic', provider: 'fixture' },
  prompt: { instructions: ['Keep public behavior.'] },
  resources: {
    skills: [{ kind: 'inline', name: 'legacy-notes', content: '# Legacy notes\n\nNothing here.' }],
  },
})

/**
 * The walkthrough's agent: it tidies only when its profile mounts the `tidy`
 * skill, so a check that needs a tidy answer passes under a profile with it.
 */
export function learningFixtureResponse(profile: Readonly<AgentProfile>, text: string): string {
  const tidies = (profile.resources?.skills ?? []).some(
    (skill) => skill.kind === 'inline' && skill.name === LEARNING_FIXTURE_SKILL,
  )
  return `${tidies ? 'tidied' : 'untouched'}: ${text}`
}
