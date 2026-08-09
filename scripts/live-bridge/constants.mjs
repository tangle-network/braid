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
    'advertised reconnect, cancel, and interaction semantics',
    'bounded process cleanup',
  ]),
  excludes: Object.freeze(['LIVE-01..05 full interactive runner conformance']),
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
    modelId: 'pi/openai-codex/gpt-5.6-luna',
    backend: 'pi',
  },
])

export const livePrompts = Object.freeze({
  normal: (key) => `Reply with exactly LIVE_BRAID_${key.toUpperCase().replaceAll('.', '_')}_OK.`,
  cancel: (key) =>
    `For LIVE_BRAID_${key.toUpperCase().replaceAll('.', '_')}_CANCEL, produce a numbered list from 1 to 1000 with one short word per line.`,
})
