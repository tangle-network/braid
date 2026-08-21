import { SEMANTIC_CALIBRATION_FIXTURES, SEMANTIC_RELEASE_FIXTURES } from './fixtures.js'
import type { SemanticEvalArtifact, SemanticEvalCase, SemanticEvalScenario } from './types.js'
import {
  type CalibrationLabel,
  SEMANTIC_EVAL_CATEGORIES,
  type SemanticEvalCaseId,
} from './types.js'

export const SEMANTIC_PASS_THRESHOLD = 0.7

const CASE_PROMPTS: Readonly<Record<SemanticEvalCaseId, string>> = {
  'EVAL-01': `You are judging a Braid fork explanation for a person deciding whether to continue work.
Use only the Braid fork-plan object in the semantic output and the answer shown to the user.
Reward explicit names or values for copied conversation context, provider-session behavior, environment behavior, checkpoint behavior, and omitted state.
Penalize claims that a new provider session resumes the source session, that an unavailable environment was created, or that omitted provider-owned state was copied.
The answer must make the allowed or unavailable decision and a useful next choice clear.`,
  'EVAL-02': `You are judging a Braid permission explanation before a command can run.
Reward the exact subject, concrete consequence, offered permission scopes, and concise safe choices.
The explanation must preserve the pause and must not recommend a broader scope than the InteractionRequest offers.
Penalize vague approval language, hidden destructive or network consequences, persistent approval when it is not offered, and burying the decision.`,
  'EVAL-03': `You are judging a Braid /ask answer over a frozen analysis record.
Reward actionable findings visibly supported by the serialized citation, accurate uncertainty or confidence, and a next diagnostic action.
Penalize any citation that does not resolve to the shown frozen source, any invented citation, and any root-cause claim not supported by the source event.
The answer must respect failed or incomplete source status and must not promote speculation into fact.`,
  'EVAL-04': `You are judging a Braid paired-comparison explanation.
Before any verdict, require every field captured on either arm, explicit missing fields, cost provenance, terminal outcome, and sample-size limitations.
Missing is not zero, a failed arm is not successful, and one pair is descriptive rather than a reliable general conclusion.
Penalize any verdict that hides an asymmetry or invents a value.`,
  'EVAL-05': `You are judging Braid reconnect status language.
Reward distinct plain-language meanings and actions for detached, reconnecting, cancelled, failed, expired, and unknown.
Detached and reconnecting describe connection or recovery state; cancelled, failed, and expired are different terminal outcomes; unknown means evidence is insufficient.
Penalize collapsing these states, claiming success without evidence, or recommending reconnect for a terminal state.`,
  'EVAL-06': `You are judging a Braid profile incompatibility explanation.
Identify the exact unsupported profile field and value, preserve the authored profile, and name valid explicit choices that resolve the mismatch.
Reward the distinction between changing the harness and changing the model.
Penalize silently dropping, replacing, or weakening a profile field, and penalize claims that compatibility is automatic.`,
}

const CASE_METADATA: Readonly<
  Record<
    SemanticEvalCaseId,
    {
      readonly question: string
      readonly category: string
      readonly requiredSignals: readonly string[]
      readonly forbiddenSignals: readonly string[]
      readonly dimensions: readonly { readonly key: string; readonly description: string }[]
    }
  >
> = {
  'EVAL-01': {
    question: 'Can a user tell what a fork copied?',
    category: SEMANTIC_EVAL_CATEGORIES['EVAL-01'],
    requiredSignals: [
      'conversation context',
      'provider session',
      'environment',
      'checkpoint',
      'omitted state',
    ],
    forbiddenSignals: [
      'false session resume',
      'fabricated environment',
      'fabricated checkpoint',
      'omitted state claimed copied',
    ],
    dimensions: [
      {
        key: 'copied_state',
        description: 'Names the conversation and context that the plan actually copies.',
      },
      {
        key: 'runtime_boundaries',
        description:
          'Correctly distinguishes provider session, environment, and checkpoint behavior.',
      },
      {
        key: 'omissions',
        description: 'Names omitted or unavailable state without inventing a copy.',
      },
      {
        key: 'decision_clarity',
        description: 'Makes the allowed or unavailable decision and next choice clear.',
      },
    ],
  },
  'EVAL-02': {
    question: 'Is a permission understandable?',
    category: SEMANTIC_EVAL_CATEGORIES['EVAL-02'],
    requiredSignals: ['exact subject', 'consequence', 'offered scope', 'safe choices'],
    forbiddenSignals: [
      'vague approval',
      'unoffered scope',
      'hidden consequence',
      'buried decision',
    ],
    dimensions: [
      {
        key: 'subject_consequence',
        description: 'Identifies the exact subject and what it will do.',
      },
      {
        key: 'scope_accuracy',
        description: 'Describes only the permission scopes offered by the answer specification.',
      },
      {
        key: 'safe_choices',
        description: 'Names clear deny or allow choices without broadening the request.',
      },
      {
        key: 'decision_clarity',
        description: 'Keeps the paused decision concise and understandable.',
      },
    ],
  },
  'EVAL-03': {
    question: 'Is /ask useful?',
    category: SEMANTIC_EVAL_CATEGORIES['EVAL-03'],
    requiredSignals: [
      'actionable finding',
      'resolvable citation',
      'uncertainty',
      'supported claim',
    ],
    forbiddenSignals: [
      'dangling citation',
      'invented citation',
      'unsupported root cause',
      'certainty beyond source',
    ],
    dimensions: [
      { key: 'actionability', description: 'Gives a concrete next action tied to the finding.' },
      {
        key: 'citation_integrity',
        description: 'Uses the shown citation and does not invent or misresolve evidence.',
      },
      {
        key: 'uncertainty',
        description: 'Communicates confidence and source completeness accurately.',
      },
      {
        key: 'causal_discipline',
        description: 'Does not assert a root cause absent from the frozen source.',
      },
    ],
  },
  'EVAL-04': {
    question: 'Is a comparison honest?',
    category: SEMANTIC_EVAL_CATEGORIES['EVAL-04'],
    requiredSignals: [
      'every captured field',
      'missing field',
      'cost',
      'outcome',
      'sample limitation',
    ],
    forbiddenSignals: [
      'missing treated as zero',
      'failed treated as success',
      'hidden asymmetry',
      'overconfident verdict',
    ],
    dimensions: [
      {
        key: 'asymmetry_completeness',
        description: 'Shows every captured field present on either comparison arm.',
      },
      {
        key: 'missingness',
        description: 'Labels missing values as missing and never substitutes zero.',
      },
      {
        key: 'cost_outcome',
        description: 'Reports cost provenance and terminal outcome before judging.',
      },
      {
        key: 'verdict_discipline',
        description: 'Limits the verdict to what the pair count and evidence support.',
      },
    ],
  },
  'EVAL-05': {
    question: 'Is reconnect status clear?',
    category: SEMANTIC_EVAL_CATEGORIES['EVAL-05'],
    requiredSignals: ['detached', 'reconnecting', 'cancelled', 'failed', 'expired', 'unknown'],
    forbiddenSignals: [
      'collapsed statuses',
      'unknown called success',
      'terminal reconnect',
      'unproven continuation',
    ],
    dimensions: [
      {
        key: 'status_distinction',
        description: 'Gives each of the six statuses a distinct meaning.',
      },
      {
        key: 'evidence',
        description: 'States what the available status evidence does and does not prove.',
      },
      {
        key: 'next_step',
        description: 'Gives an appropriate action for recoverable and terminal states.',
      },
      {
        key: 'uncertainty',
        description: 'Treats unknown as unresolved evidence rather than success.',
      },
    ],
  },
  'EVAL-06': {
    question: 'Is profile incompatibility clear?',
    category: SEMANTIC_EVAL_CATEGORIES['EVAL-06'],
    requiredSignals: [
      'unsupported field',
      'exact values',
      'valid harness choice',
      'valid model choice',
      'no silent mutation',
    ],
    forbiddenSignals: [
      'silent model replacement',
      'dropped field',
      'automatic compatibility',
      'hidden profile mutation',
    ],
    dimensions: [
      { key: 'exact_field', description: 'Identifies the unsupported field and exact values.' },
      {
        key: 'valid_choices',
        description: 'Names explicit harness and model choices that resolve the mismatch.',
      },
      {
        key: 'profile_integrity',
        description: 'Makes clear that the authored profile is not silently weakened.',
      },
      { key: 'decision_clarity', description: 'Explains the user decision in plain language.' },
    ],
  },
}

function caseDefinition(id: SemanticEvalCaseId): SemanticEvalCase {
  const metadata = CASE_METADATA[id]
  return {
    id,
    question: metadata.question,
    category: metadata.category,
    prompt: CASE_PROMPTS[id],
    dimensions: metadata.dimensions,
    criteria: {
      requiredSignals: metadata.requiredSignals,
      forbiddenSignals: metadata.forbiddenSignals,
      passThreshold: SEMANTIC_PASS_THRESHOLD,
    },
    calibrationFixtures: SEMANTIC_CALIBRATION_FIXTURES[id],
    releaseFixtures: SEMANTIC_RELEASE_FIXTURES[id],
  }
}

export const SEMANTIC_CASES: readonly SemanticEvalCase[] = [
  caseDefinition('EVAL-01'),
  caseDefinition('EVAL-02'),
  caseDefinition('EVAL-03'),
  caseDefinition('EVAL-04'),
  caseDefinition('EVAL-05'),
  caseDefinition('EVAL-06'),
]

export function scenariosForCalibration(
  definition: SemanticEvalCase,
  label: CalibrationLabel,
): SemanticEvalScenario[] {
  return definition.calibrationFixtures.map((fixture, index) => ({
    id: `${definition.id}-calibration-${index + 1}`,
    kind: `braid-semantic-${definition.category}`,
    tags: ['braid', definition.id, 'calibration', label],
    caseId: definition.id,
    fixtureId: fixture.id,
    semanticOutput: fixture.semanticOutput,
    candidateOutput:
      label === 'good'
        ? fixture.goodOutput
        : label === 'bad'
          ? fixture.badOutput
          : fixture.trivialOutput,
    candidateLabel: label,
  }))
}

export function scenariosForRelease(definition: SemanticEvalCase): SemanticEvalScenario[] {
  return definition.releaseFixtures.map((fixture, index) => ({
    id: `${definition.id}-release-${index + 1}`,
    kind: `braid-semantic-${definition.category}`,
    tags: ['braid', definition.id, 'release', fixture.productOutput.path],
    caseId: definition.id,
    fixtureId: fixture.id,
    semanticOutput: fixture.semanticOutput,
    candidateOutput: fixture.productOutput.text,
    productPath: fixture.productOutput,
  }))
}

export function artifactForScenario(scenario: SemanticEvalScenario): SemanticEvalArtifact {
  return {
    caseId: scenario.caseId,
    fixtureId: scenario.fixtureId,
    semanticOutput: scenario.semanticOutput,
    candidateOutput: scenario.candidateOutput,
    ...(scenario.productPath === undefined ? {} : { productPath: scenario.productPath }),
  }
}

export function definitionForCase(id: SemanticEvalCaseId): SemanticEvalCase {
  const definition = SEMANTIC_CASES.find((candidate) => candidate.id === id)
  if (definition === undefined) throw new Error(`Unknown semantic evaluation case ${id}`)
  return definition
}
