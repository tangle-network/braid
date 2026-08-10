import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createInteractionRequest,
  interactionResponseBinding,
} from '../src/app/interaction-request.js'
import type { BraidEvent, BraidEventEnvelope } from '../src/domain/events.js'
import type { BraidViewModel, InteractionView } from '../src/views/shared/models.js'
import { plainAccessibilityText, plainEventText } from '../src/views/shared/plain-accessibility.js'
import { projectSemanticEvent } from '../src/views/shared/semantic-projection.js'

const request = createInteractionRequest({
  id: 'interaction-plain',
  kind: 'permission',
  title: 'Allow workspace inspection',
  body: 'The agent wants to inspect the package manifest.',
  subject: { type: 'command', command: 'git diff -- package.json' },
  answerSpec: {
    fields: [
      {
        type: 'select',
        name: 'permission',
        label: 'Permission',
        required: true,
        options: [
          { value: 'once', label: 'Allow once', description: 'Allow this request only.' },
          { value: 'session', label: 'Allow session' },
        ],
      },
    ],
  },
  responseScopes: ['interaction', 'session'],
  allowedOutcomes: ['accepted', 'declined', 'cancelled'],
  binding: {
    runId: 'run-plain',
    provider: 'fixture',
    environmentId: 'environment-plain',
    sessionId: 'session-plain',
    executionId: 'execution-plain',
    interactionId: 'interaction-plain',
  },
})

test('semantic projection keeps detached state and only public interaction request fields', () => {
  const detached = projectSemanticEvent(
    envelope({
      kind: 'run.detached',
      runId: 'run-plain',
      cursor: 'cursor-plain',
      detail: 'local stream detached',
    }),
  )
  assert.deepEqual(detached, {
    status: 'detached',
    completeness: 'streaming',
    cursor: 'cursor-plain',
    detail: 'local stream detached',
  })

  const interaction = projectSemanticEvent(
    envelope({
      kind: 'run.interaction',
      runId: 'run-plain',
      request,
      responseBinding: interactionResponseBinding(request),
      provider: { eventId: 'provider-plain', providerSequence: 1 },
    }),
  )
  const projected = interaction.interaction as Record<string, unknown>
  assert.equal(projected.title, 'Allow workspace inspection')
  assert.equal(projected.body, 'The agent wants to inspect the package manifest.')
  assert.deepEqual(projected.subject, {
    type: 'command',
    command: 'git diff -- package.json',
  })
  assert.deepEqual(projected.responseScopes, ['interaction', 'session'])
  assert.deepEqual(projected.allowedOutcomes, ['accepted', 'declined', 'cancelled'])
  assert.equal('binding' in projected, false)
  assert.equal('default' in projected, false)
  assert.equal(JSON.stringify(interaction).includes('\u001b'), false)
  assert.equal(JSON.stringify(interaction).includes('\u0007'), false)
})

test('plain interaction events expose the request needed for a safe decision', () => {
  const payload = projectSemanticEvent(
    envelope({
      kind: 'run.interaction',
      runId: 'run-plain',
      request,
      responseBinding: interactionResponseBinding(request),
      provider: { eventId: 'provider-plain', providerSequence: 1 },
    }),
  )
  const output = plainEventText(minimalView({ statusText: 'waiting for permission' }), {
    sequence: 4,
    revision: 4,
    kind: 'run.interaction',
    payload,
  })

  assert.match(output, /interaction title: Allow workspace inspection/u)
  assert.match(output, /interaction subject: command: git diff -- package\.json/u)
  assert.match(output, /interaction body: The agent wants to inspect the package manifest\./u)
  assert.match(output, /response scopes: interaction, session/u)
  assert.match(output, /allowed outcomes: accepted, declined, cancelled/u)
  assert.match(
    output,
    /select choices \(Permission\): Allow once \[once\]; Allow session \[session\]/u,
  )
})

test('plain lifecycle events name the state and one honest next action', () => {
  const events: readonly BraidEvent[] = [
    {
      kind: 'run.detached',
      runId: 'run-plain',
      cursor: 'cursor-plain',
      detail: 'local stream detached',
    },
    { kind: 'run.reconnecting', runId: 'run-plain', after: 'cursor-plain' },
    {
      kind: 'run.finished',
      runId: 'run-plain',
      status: 'cancelled',
      finalText: '',
      usage: { input: 1, output: 0 },
      reason: 'user_cancelled',
    },
    {
      kind: 'run.finished',
      runId: 'run-plain',
      status: 'failed',
      finalText: '',
      usage: { input: 1, output: 0 },
      error: 'provider failed',
    },
    {
      kind: 'run.finished',
      runId: 'run-plain',
      status: 'expired',
      finalText: '',
      usage: { input: 1, output: 0 },
      reason: 'response_window_expired',
    },
    { kind: 'run.unknown', runId: 'run-plain', detail: 'provider history is unavailable' },
  ]

  for (const [index, event] of events.entries()) {
    const payload = projectSemanticEvent(envelope(event))
    const output = plainEventText(minimalView(), {
      sequence: index + 1,
      revision: index + 1,
      kind: event.kind,
      payload,
    })
    assert.match(output, /state: /u)
    assert.match(output, /next action: /u)
  }

  const unknownEvent = events.at(-1)
  assert.ok(unknownEvent)
  const unknown = projectSemanticEvent(envelope(unknownEvent))
  const unknownOutput = plainEventText(minimalView(), {
    sequence: 6,
    revision: 6,
    kind: 'run.unknown',
    payload: unknown,
  })
  assert.match(unknownOutput, /state: unknown/u)
  assert.match(unknownOutput, /completion is unconfirmed/u)
  assert.doesNotMatch(unknownOutput, /status: completed/u)
})

test('plain accessibility output includes non-secret interaction details and choices', () => {
  const interaction: InteractionView = {
    runId: 'run-plain',
    interactionId: 'interaction-plain',
    kind: 'permission',
    prompt: 'Choose permission',
    subject: {
      type: 'command',
      title: 'git diff -- package.json',
      target: 'package.json',
      detail: 'Read the current package manifest.',
    },
    answerSpec: {
      kind: 'select',
      required: true,
      options: [
        { value: 'once', label: 'Allow once' },
        { value: 'session', label: 'Allow session' },
      ],
    },
    responseScopes: ['once', 'session'],
    allowedOutcomes: ['accept', 'reject', 'cancel'],
    queuePosition: 0,
    secret: false,
  }
  const output = plainAccessibilityText(minimalView({ interactions: [interaction] }))
  assert.match(
    output,
    /interaction subject: command: git diff -- package\.json; target: package\.json/u,
  )
  assert.match(output, /interaction subject detail: Read the current package manifest\./u)
  assert.match(output, /response scopes: once, session/u)
  assert.match(output, /interaction allowed outcomes: accept, reject, cancel/u)
  assert.match(output, /answer choices: Allow once \[once\]; Allow session \[session\]/u)
})

function envelope(event: BraidEvent): BraidEventEnvelope {
  return {
    sequence: 1,
    revision: 1,
    occurredAt: '2026-08-10T00:00:00.000Z',
    event,
  }
}

function minimalView(overrides: Partial<BraidViewModel> = {}): BraidViewModel {
  return {
    statusText: 'ready',
    conversationTitle: 'Plain test',
    branch: 'main',
    profileName: 'profile',
    runner: 'runner',
    connection: 'connection',
    appearance: { color: 'none', highContrast: false, reducedMotion: false },
    messages: [],
    queue: [],
    interactions: [],
    ...overrides,
  } as unknown as BraidViewModel
}
