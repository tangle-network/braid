import type { AgentProfile } from '@tangle-network/agent-interface'
import { defineAgentProfile } from '@tangle-network/agent-interface/profile'

/** The skill the offline learning walkthrough's agent acts on. */
export const LEARNING_FIXTURE_SKILL = 'tidy'
/** The child profile the agent can hand the same work to. */
export const LEARNING_FIXTURE_SUBAGENT = 'tidier'

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

/** The rule that makes the walkthrough's agent tidy when its instructions carry it. */
export const LEARNING_FIXTURE_RULE = /remove dead code/i

/**
 * The walkthrough's agent: it tidies only when its profile mounts the `tidy`
 * skill, carries a `tidier` child profile to hand the work to, or its
 * instructions tell it to remove dead code, so a check that needs a tidy
 * answer passes under a profile with any of them.
 */
export function learningFixtureResponse(profile: Readonly<AgentProfile>, text: string): string {
  const tidies =
    (profile.resources?.skills ?? []).some(
      (skill) => skill.kind === 'inline' && skill.name === LEARNING_FIXTURE_SKILL,
    ) ||
    profile.subagents?.[LEARNING_FIXTURE_SUBAGENT] !== undefined ||
    (profile.prompt?.instructions ?? []).some((line) => LEARNING_FIXTURE_RULE.test(line))
  return `${tidies ? 'tidied' : 'untouched'}: ${text}`
}
