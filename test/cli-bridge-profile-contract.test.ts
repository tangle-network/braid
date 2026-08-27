import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { createBraidApplication } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import { FixedClock } from '../src/ports/clock.js'
import { SequenceIds } from '../src/ports/ids.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const at = '2026-08-03T12:00:00.000Z'
const workspaceCwd = '/tmp/braid-contract-workspace'

const profile: AgentProfile = {
  name: 'braid-profile-contract',
  description: 'Profile contract fixture',
  version: '1.0.0',
  tags: ['contract', 'profile'],
  prompt: {
    systemPrompt: 'Use the selected profile exactly.',
    instructions: ['Keep answers concise.'],
  },
  model: {
    default: 'gpt-5.6-luna',
    small: 'gpt-5.5',
    provider: 'openai-codex',
    reasoningEffort: 'high',
    metadata: { maxTurns: 1 },
  },
  harness: 'pi',
  permissions: { read: 'allow', write: 'ask' },
  tools: { read: true, write: false },
  mcp: {
    disabled: { enabled: false },
    remote: { transport: 'http', url: 'https://example.com/mcp', metadata: { scope: 'contract' } },
  },
  connections: [{ connectionId: 'hub-demo', capabilities: ['tickets.read'], alias: 'tickets' }],
  subagents: {
    reviewer: {
      description: 'Reviews the response',
      prompt: 'Review only.',
      model: 'openai-codex/gpt-5.5',
      tools: { read: true },
      permissions: { read: 'allow' },
      maxSteps: 2,
      metadata: { role: 'reviewer' },
    },
  },
  resources: {
    files: [
      {
        path: 'AGENTS.md',
        resource: { kind: 'inline', name: 'contract', content: 'Contract instructions.' },
      },
    ],
    tools: [{ kind: 'inline', name: 'tool', content: 'Tool description.' }],
    skills: [{ kind: 'inline', name: 'skill', content: 'Skill description.' }],
    agents: [{ kind: 'inline', name: 'agent', content: 'Agent description.' }],
    commands: [{ kind: 'inline', name: 'command', content: 'Command description.' }],
    instructions: { kind: 'inline', name: 'instructions', content: 'Resource instructions.' },
    failOnError: true,
  },
  modes: {
    review: {
      description: 'Review mode',
      model: 'openai-codex/gpt-5.5',
      prompt: 'Review.',
      tools: { read: true },
      permissions: { read: 'allow' },
      metadata: { mode: true },
    },
  },
  confidential: { tee: 'any', sealed: false },
  metadata: { contract: 'all-profile-dimensions' },
  extensions: { 'provider.test': { enabled: true, version: 1 } },
}

test('canonical retained CLI Bridge forwards the complete profile and exact turn identity', async () => {
  const bridge = await startRuntimeBridgeServer({ responseText: 'CONTRACT_OK' })
  const connection: ConnectionRecord = {
    id: createConnectionId('connection-cli-profile-contract'),
    kind: 'cli-bridge',
    name: 'Contract CLI Bridge',
    endpoint: bridge.endpoint,
    providerOptions: { transport: 'local' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
  const clock = new FixedClock()
  const journal = new MemoryJournal(clock)
  let app: ReturnType<typeof createBraidApplication> | undefined

  try {
    app = createBraidApplication({
      production: {
        profile,
        connections: [connection],
        connectionId: connection.id,
        workspaceRoot: workspaceCwd,
      },
      clock,
      ids: new SequenceIds(),
      journal,
      effectStorage: journal,
    })
    app.initialize(workspaceCwd)
    const send = app.send({
      operationId: 'operation-cli-profile-contract',
      text: 'Forward every profile field through the canonical retained path.',
    })
    await send.admissionReady
    const state = await send.completion
    const run = state.runs[0]
    const sessionCreate = bridge.sessionCreates[0]
    const turn = bridge.requests[0]
    assert(run?.controlRef && sessionCreate && turn)

    assert.equal(bridge.sessionCreates.length, 1)
    assert.equal(bridge.requests.length, 1)
    assert.deepEqual(sessionCreate.body.agent_profile, profile)
    assert.equal(sessionCreate.body.model, 'pi/openai-codex/gpt-5.6-luna')
    assert.equal(sessionCreate.body.cwd, workspaceCwd)
    assert.equal(sessionCreate.sessionId, run.controlRef.sessionId)

    assert.equal(
      turn.body.message,
      'Forward every profile field through the canonical retained path.',
    )
    assert.equal(turn.body.run_id, run.controlRef.runId)
    assert.equal(turn.body.provider, run.controlRef.provider)
    assert.equal(turn.body.environment_id, run.controlRef.environmentId)
    assert.equal(turn.body.execution_id, run.controlRef.executionId)
    assert.equal(turn.sessionId, run.controlRef.sessionId)
    assert.equal(JSON.stringify(sessionCreate.body).includes('inline-'), false)
  } finally {
    await app?.close()
    await bridge.close()
  }
})
