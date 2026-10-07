import type { FeedbackTrajectory, PreferenceMemoryEntry } from '@tangle-network/agent-eval'
import type { AgentProfile, AgentProfileDiff } from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigestHex,
  composeAgentProfileGuidance,
  diffAgentProfiles,
} from '../adapters/agent-interface/profile-runtime.js'
import { AppError } from './errors.js'
import { assertValidProfile } from './profile-validation.js'

export interface LearnedProfileDraft {
  readonly kind: 'learned-profile-draft'
  readonly status: 'unmeasured'
  readonly sourceProfileDigest: string
  readonly candidateDigest: string
  readonly profile: Readonly<AgentProfile>
  readonly changes: readonly AgentProfileDiff[]
  readonly lessons: readonly PreferenceMemoryEntry[]
  readonly feedbackIds: readonly string[]
}

/** User corrections become portable guidance; Eval owns their interpretation. */
export async function draftProfileFromFeedback(
  profile: Readonly<AgentProfile>,
  trajectories: readonly FeedbackTrajectory[],
): Promise<LearnedProfileDraft> {
  const { summarizePreferenceMemory, renderPreferenceMemoryMarkdown } = await import(
    '@tangle-network/agent-eval'
  )
  const lessons = summarizePreferenceMemory([...trajectories], { maxEntries: 20 })
  if (lessons.length === 0) {
    throw new AppError(
      'PROFILE_LESSONS_UNAVAILABLE',
      'Record task feedback with a reason before learning a profile. Acceptance alone does not specify an instruction.',
    )
  }
  const candidate = composeAgentProfileGuidance(
    profile,
    [{ source: 'braid.feedback', id: 'user-lessons', text: renderPreferenceMemoryMarkdown(lessons) }],
    'instructions',
    { replaceSources: ['braid.feedback'] },
  )
  assertValidProfile(candidate)
  return Object.freeze({
    kind: 'learned-profile-draft',
    status: 'unmeasured',
    sourceProfileDigest: canonicalAgentProfileDigestHex(profile),
    candidateDigest: canonicalAgentProfileDigestHex(candidate),
    profile: candidate,
    changes: diffAgentProfiles(profile, candidate),
    lessons,
    feedbackIds: [...new Set(lessons.map((lesson) => lesson.sourceTrajectoryId))],
  })
}
