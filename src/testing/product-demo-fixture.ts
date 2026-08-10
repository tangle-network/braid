import type { AgentProfile } from '@tangle-network/agent-interface'
import { defineAgentProfile } from '../adapters/agent-interface/profile-runtime.js'
import type { ConnectionRecord } from '../domain/entities.js'
import { createConnectionId, createCredentialRefId } from '../domain/ids.js'

const capturedAt = '2026-08-09T00:00:00.000Z'

export const PRODUCT_DEMO_CONNECTION_ID = createConnectionId('connection-local-cli-bridge')

export const PRODUCT_DEMO_PROFILE: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Release engineer',
  description: 'Ships durable changes with concise, reproducible evidence',
  version: '1.0.0',
  tags: ['coding', 'release'],
  harness: 'pi',
  model: {
    default: 'openai-codex/gpt-5.6-luna',
    provider: 'openai-codex',
    reasoningEffort: 'high',
  },
  prompt: {
    instructions: [
      'Inspect the repository before changing it.',
      'Run focused checks and report exact evidence.',
    ],
  },
  tools: { read: true, write: true, shell: true },
  permissions: { read: 'allow', write: 'ask', shell: 'ask' },
  resources: {
    skills: [
      {
        kind: 'inline',
        name: 'verify-before-ship',
        content: 'Run the smallest relevant check before reporting a result.',
      },
    ],
  },
  metadata: { 'braid.productDemo': true },
})

export const PRODUCT_DEMO_CONNECTION: ConnectionRecord = Object.freeze({
  id: PRODUCT_DEMO_CONNECTION_ID,
  kind: 'cli-bridge',
  name: 'Local CLI Bridge',
  endpoint: 'http://127.0.0.1:3344/v1',
  credentialRef: createCredentialRefId('credential-ref-local-subscription'),
  providerOptions: {
    transport: 'local',
    capabilityHints: ['streaming', 'usage', 'session-continuity'],
  },
  createdAt: capturedAt,
  updatedAt: capturedAt,
  lastHealth: { status: 'healthy', checkedAt: capturedAt },
  lastModelVerification: {
    model: 'openai-codex/gpt-5.6-luna',
    status: 'verified',
    checkedAt: capturedAt,
  },
} satisfies ConnectionRecord)

export function isProductDemoProfile(profile: Readonly<AgentProfile>): boolean {
  return profile.metadata?.['braid.productDemo'] === true
}
