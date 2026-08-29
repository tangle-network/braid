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
])

export const releaseRunnerTargetDefinitions = Object.freeze([
  {
    key: 'pi-tangle-router-deepseek-v4-flash',
    label: 'Pi with Tangle Router DeepSeek V4 Flash',
    modelId: 'pi/tangle-router/deepseek-v4-flash',
    backend: 'pi',
  },
  {
    key: 'codex-default',
    label: 'Codex default',
    modelId: 'codex/default',
    backend: 'codex',
  },
])

function marker(key, suffix) {
  return `LIVE_BRAID_${key.toUpperCase().replaceAll('.', '_')}_${suffix}`
}

export const liveMarkers = Object.freeze({
  normal: (key) => marker(key, 'OK'),
  cancel: (key) => marker(key, 'CANCEL'),
  handoffSource: (key) => marker(key, 'HANDOFF_SOURCE_OK'),
  handoffDestination: (key) => marker(key, 'HANDOFF_OK'),
  interactive: (key) => marker(key, 'INTERACTIVE_OK'),
  restart: (key) => marker(key, 'RESTART'),
})

export const livePrompts = Object.freeze({
  normal: (key) =>
    `Output only this token, with no punctuation or explanation: ${liveMarkers.normal(key)}`,
  cancel: (key) =>
    `For ${liveMarkers.cancel(key)}, produce a numbered list from 1 to 1000 with one short word per line.`,
  handoffSource: (key) =>
    `Output only this token, with no punctuation or explanation: ${liveMarkers.handoffSource(key)}`,
  handoffDestination: (key) =>
    `Output only this token, with no punctuation or explanation: ${liveMarkers.handoffDestination(key)}`,
  interactive: (key) =>
    `Use the read tool now to read ./interaction-proof-${key}.txt. Do not guess its contents or answer without the tool call. After the permission response, report what happened.`,
  restart: (key) =>
    `Do not use tools. Reply directly with ${liveMarkers.restart(key)}, then count from 1 to 1000 with one integer per line.`,
})
