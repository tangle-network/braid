import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repository = resolve(fileURLToPath(new URL('../../', import.meta.url)))
export const exitCodes = Object.freeze({ passed: 0, failed: 1, unavailable: 2 })
export const defaultTimeoutMs = 120_000
export const liveProofScope = Object.freeze({
  name: 'one-shot-production-target-proof',
  claims: Object.freeze([
    'packed startup',
    'exact marker response for each required target',
    'advertised cancel and interaction semantics',
    'bounded process cleanup',
  ]),
  excludes: Object.freeze(['LIVE-01..05 full interactive runner conformance']),
})

export const liveReleaseProofScope = Object.freeze({
  name: 'packed-cli-bridge-release-proof',
  claims: Object.freeze([
    'packed startup',
    'operation-specific Pi conformance',
    'operation-specific Codex cross-runner handoff',
    'operation-specific interactive protocol',
    'operation-specific restart reconciliation',
    'operation-specific conformance for every advertised runner',
    'bounded process cleanup',
  ]),
  excludes: Object.freeze([]),
})

export const liveReleaseProofOperations = Object.freeze({
  pi: 'cli-bridge.pi.conformance',
  codexHandoff: 'cli-bridge.codex.cross-runner-handoff',
  interactive: 'cli-bridge.interactive-protocol',
  restart: 'cli-bridge.restart-reconciliation',
  runner: 'cli-bridge.runner-conformance',
})

export const targetDefinitions = Object.freeze([
  {
    key: 'glm-5.2',
    label: 'GLM 5.2',
    modelId: 'opencode/zai-coding-plan/glm-5.2',
    backend: 'opencode',
  },
  {
    key: 'luna-max',
    label: 'Luna Max',
    modelId: 'pi/tangle-router/openai/gpt-5.6-luna',
    backend: 'pi',
  },
])

export const livePrompts = Object.freeze({
  normal: (key) => `Reply with exactly LIVE_BRAID_${key.toUpperCase().replaceAll('.', '_')}_OK.`,
  cancel: (key) =>
    `For LIVE_BRAID_${key.toUpperCase().replaceAll('.', '_')}_CANCEL, produce a numbered list from 1 to 1000 with one short word per line.`,
  handoffSource: (key) =>
    `Reply with exactly LIVE_BRAID_${key.toUpperCase().replaceAll('.', '_')}_HANDOFF_SOURCE_OK.`,
  handoffDestination: (key) =>
    `Reply with exactly LIVE_BRAID_${key.toUpperCase().replaceAll('.', '_')}_HANDOFF_OK.`,
  interactive: (key) =>
    `Ask one user-visible permission question before completing LIVE_BRAID_${key.toUpperCase().replaceAll('.', '_')}_INTERACTIVE_OK.`,
  restart: (key) =>
    `For LIVE_BRAID_${key.toUpperCase().replaceAll('.', '_')}_RESTART, produce a numbered list from 1 to 1000 with one short word per line.`,
})
