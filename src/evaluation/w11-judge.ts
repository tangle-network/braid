import { type ChatClient, llmJudge } from '@tangle-network/agent-eval'
import type { JudgeConfig, Scenario } from '@tangle-network/agent-eval/campaign'
import type { W11Judge, W11JudgeObservation } from './w11-types.js'

function observationFromScore(
  input: { readonly candidate: string; readonly reference: string; readonly scenario: Scenario },
  score: Awaited<
    ReturnType<JudgeConfig<{ readonly candidate: string; readonly reference: string }>['score']>
  >,
): W11JudgeObservation {
  return {
    input,
    output: score.notes,
    score: score.composite,
    notes: score.notes,
    costUsd: score.llmCall?.costUsd ?? null,
    tokens: score.llmCall
      ? {
          input: score.llmCall.usage.promptTokens,
          output: score.llmCall.usage.completionTokens,
          total: score.llmCall.usage.totalTokens,
        }
      : null,
    disagreement: score.maxDisagreement ?? null,
  }
}

/** Adapts agent-eval's judge contract to the W11 observation record. */
export function createW11Judge(
  config: JudgeConfig<{ readonly candidate: string; readonly reference: string }>,
  source: W11Judge['source'] = 'live',
): W11Judge {
  const version = config.judgeVersion?.trim()
  if (!version) throw new Error(`W11 judge ${config.name} requires an explicit version`)
  return {
    source,
    name: config.name,
    version,
    async judge(input) {
      const request = { candidate: input.candidate, reference: input.reference }
      const score = await config.score({
        artifact: request,
        scenario: input.scenario,
        signal: input.signal ?? new AbortController().signal,
      })
      return observationFromScore(
        { candidate: input.candidate, reference: input.reference, scenario: input.scenario },
        score,
      )
    },
  }
}

export function createLiveW11Judge(chat: ChatClient, model?: string): W11Judge {
  const config = llmJudge<{ readonly candidate: string; readonly reference: string }>(
    'braid-w11-semantic',
    'Judge whether the candidate satisfies the reference behavior. Score evidence, correctness, and actionable clarity. Do not reward generic confidence or unsupported claims.',
    {
      chat,
      ...(model ? { model } : {}),
      dimensions: [
        {
          key: 'correctness',
          description: 'The candidate implements or explains the referenced behavior accurately.',
        },
        {
          key: 'evidence',
          description: 'The candidate distinguishes observed facts from unsupported claims.',
        },
        {
          key: 'clarity',
          description: 'The candidate is specific enough to guide a user or maintainer.',
        },
      ],
      weights: { correctness: 0.5, evidence: 0.3, clarity: 0.2 },
      judgeVersion: 'braid-w11-semantic-1',
    },
  )
  return createW11Judge(config)
}
