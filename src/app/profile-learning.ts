import type { FeedbackTrajectory, PreferenceMemoryEntry } from '@tangle-network/agent-eval'
import type { AgentProfile, AgentProfileDiff } from '@tangle-network/agent-interface'
import { canonicalAgentProfileDigestHex } from '../adapters/agent-interface/profile-runtime.js'
import { composeAgentProfileGuidance } from '@tangle-network/agent-interface/profile'
import { diffAgentProfiles } from '@tangle-network/agent-interface'
import { AppError } from './errors.js'
import { exportProfileDocument } from './profile-persistence.js'

export interface LearnedProfileDraft {
  readonly kind: 'learned-profile-draft'
  readonly status: 'unmeasured'
  readonly sourceProfileDigest: string
  readonly candidateDigest: string
  readonly redacted: boolean
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
  const portable = exportProfileDocument(profile).profile
  const candidate = composeAgentProfileGuidance(
    portable,
    [
      {
        source: 'braid.feedback',
        id: 'user-lessons',
        text: renderPreferenceMemoryMarkdown(lessons),
      },
    ],
    'instructions',
    { replaceSources: ['braid.feedback'] },
  )
  return Object.freeze({
    kind: 'learned-profile-draft',
    status: 'unmeasured',
    sourceProfileDigest: canonicalAgentProfileDigestHex(profile),
    candidateDigest: canonicalAgentProfileDigestHex(candidate),
    redacted: canonicalAgentProfileDigestHex(portable) !== canonicalAgentProfileDigestHex(profile),
    profile: candidate,
    changes: diffAgentProfiles(profile, candidate),
    lessons,
    feedbackIds: [...new Set(lessons.map((lesson) => lesson.sourceTrajectoryId))],
  })
}
