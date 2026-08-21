import type { AgentProfile, AgentProfileDiff } from '@tangle-network/agent-interface'
import {
  canonicalCandidateJson,
  diffAgentProfiles,
  snapshotAgentProfile,
} from '../adapters/agent-interface/profile-runtime.js'
import { redactSensitiveText } from '../domain/secret-sanitizer.js'
import type { ProfileDraftValidation } from './profile-types.js'
import { ProfileValidationError, validateProfileShape } from './profile-validation.js'

function cloneCandidate(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new ProfileValidationError([
      {
        origin: 'schema',
        level: 'error',
        code: 'profile-draft-not-cloneable',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error), 4096),
      },
    ])
  }
}

/** One canonical profile draft shared by structured and raw editing surfaces. */
export class ProfileDraft {
  readonly #base: Readonly<AgentProfile>
  #candidate: unknown
  #validation: ProfileDraftValidation

  constructor(profile: AgentProfile) {
    const initial = validateProfileShape(profile)
    if (!initial.ok || initial.profile === undefined) {
      throw new ProfileValidationError(initial.issues)
    }
    this.#base = initial.profile
    this.#candidate = initial.profile
    this.#validation = initial
  }

  get candidate(): unknown {
    return cloneCandidate(this.#candidate)
  }

  get validation(): ProfileDraftValidation {
    return this.#validation
  }

  get valid(): boolean {
    return this.#validation.ok && this.#validation.profile !== undefined
  }

  get profile(): Readonly<AgentProfile> {
    if (!this.valid || this.#validation.profile === undefined) {
      throw new ProfileValidationError(this.#validation.issues)
    }
    return this.#validation.profile
  }

  get digest(): ProfileDraftValidation['digest'] {
    return this.#validation.digest
  }

  replace(value: unknown): ProfileDraftValidation {
    this.#candidate = cloneCandidate(value)
    this.#validation = validateProfileShape(this.#candidate)
    return this.#validation
  }

  replaceRaw(json: string): ProfileDraftValidation {
    try {
      return this.replace(JSON.parse(json))
    } catch (error) {
      this.#candidate = json
      this.#validation = {
        ok: false,
        issues: [
          {
            origin: 'schema',
            level: 'error',
            code: 'profile-json-invalid',
            message: redactSensitiveText(
              error instanceof Error ? error.message : String(error),
              4096,
            ),
          },
        ],
      }
      return this.#validation
    }
  }

  replaceProfile(profile: AgentProfile): ProfileDraftValidation {
    return this.replace(snapshotAgentProfile(profile))
  }

  rawJson(pretty = false): string {
    if (this.valid) {
      const json = canonicalCandidateJson(this.profile)
      if (!pretty) return json
      return `${JSON.stringify(this.profile, null, 2)}\n`
    }
    if (typeof this.#candidate === 'string') return this.#candidate
    return pretty
      ? `${JSON.stringify(this.#candidate, null, 2)}\n`
      : (JSON.stringify(this.#candidate) ?? '')
  }

  diff(): readonly AgentProfileDiff[] {
    if (!this.valid) return []
    return diffAgentProfiles(this.#base, this.profile)
  }
}
