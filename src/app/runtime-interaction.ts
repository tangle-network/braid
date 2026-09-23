import type { InteractionRequest } from '@tangle-network/agent-interface'
import {
  assertBoundedStructure,
  boundedText,
  BoundError,
  MAX_ID_BYTES,
  MAX_SELECT_OPTIONS,
  MAX_TEXT_BYTES,
  utf8Bytes,
} from '../domain/bounds.js'

export type RuntimeQuestion = {
  readonly id: string
  readonly question: string
  readonly reason: string
  readonly answerType: string
  readonly impactIfUnknown: string
  readonly options?: readonly string[]
}

export function assertRuntimeSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || utf8Bytes(value) > MAX_ID_BYTES) {
    throw new Error('Provider session identity is invalid')
  }
}

export function runtimeQuestionRequest(question: RuntimeQuestion): InteractionRequest {
  try {
    assertBoundedStructure(question, {
      maxBytes: MAX_TEXT_BYTES,
      maxDepth: 8,
      maxArrayLength: MAX_SELECT_OPTIONS,
      maxObjectKeys: 16,
      maxFields: 64,
    })
  } catch (error) {
    throw new Error(error instanceof BoundError ? error.message : 'Runtime question is too large')
  }
  if (!['free_text', 'select_one', 'multi_select', 'credential'].includes(question.answerType)) {
    throw new Error('Runtime question answer type is unsupported')
  }
  const rawOptions = question.options ?? []
  if (!Array.isArray(rawOptions) || rawOptions.some((option) => typeof option !== 'string')) {
    throw new Error('Runtime question options must be strings')
  }
  if (rawOptions.some((option) => option.trim().length === 0)) {
    throw new Error('Runtime select question contains an empty option label')
  }
  const options = rawOptions.map((option) => ({ value: option, label: option }))
  if (
    (question.answerType === 'select_one' || question.answerType === 'multi_select') &&
    !options.length
  ) {
    throw new Error('Runtime select question has no renderable options')
  }
  const field =
    question.answerType === 'credential'
      ? { type: 'secret' as const, name: 'answer', label: 'Answer', required: true }
      : question.answerType === 'select_one' || question.answerType === 'multi_select'
        ? {
            type: 'select' as const,
            name: 'answer',
            label: 'Answer',
            required: true,
            multi: question.answerType === 'multi_select',
            options,
          }
        : { type: 'text' as const, name: 'answer', label: 'Answer', required: true }
  return {
    id: boundedText(question.id, 512),
    kind: 'question',
    title: boundedText(question.question, 4_096),
    body: boundedText(`${question.reason}\n${question.impactIfUnknown}`, 16_384),
    answerSpec: { fields: [field] },
  }
}
