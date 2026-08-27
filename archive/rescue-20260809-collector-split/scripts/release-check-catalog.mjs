export const REQUIREMENT_PATTERN = /\b[A-Z]{2,4}-[0-9]{2}\b/gu
export const SHA256_PATTERN = /^[a-f0-9]{64}$/u

export const SHA512_INTEGRITY_PATTERN =
  /^sha512-(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

export const CHECK_CATEGORIES = new Set([
  'unit',
  'contract',
  'subprocess',
  'terminal',
  'live',
  'performance',
  'security',
  'eval',
  'release',
])

export const REQUIRED_CHECKS = new Map([
  ['repository', { category: 'release', command: 'pnpm check' }],
  ['unit', { category: 'unit', command: 'pnpm test:unit' }],
  ['contract', { category: 'contract', command: 'pnpm test:contract' }],
  ['coordination', { category: 'contract', command: 'pnpm test:coordination' }],
  ['rpc', { category: 'subprocess', command: 'pnpm test:rpc' }],
  ['rpc-packed', { category: 'subprocess', command: 'pnpm test:rpc:packed' }],
  ['virtual-terminal', { category: 'terminal', command: 'pnpm test:virtual-terminal' }],
  ['pty', { category: 'terminal', command: 'pnpm test:pty' }],
  ['storage', { category: 'contract', command: 'pnpm test:storage' }],
  ['crash', { category: 'subprocess', command: 'pnpm test:crash' }],
  ['security', { category: 'security', command: 'pnpm test:security' }],
  ['performance', { category: 'performance', command: 'pnpm test:performance' }],
  ['live-bridge', { category: 'live', command: 'pnpm test:live:bridge' }],
  ['live-tangle', { category: 'live', command: 'pnpm test:live:tangle' }],
  ['live-supervisor', { category: 'live', command: 'pnpm test:live:supervisor' }],
  ['live-analysis', { category: 'live', command: 'pnpm test:live:analysis' }],
  ['eval', { category: 'eval', command: 'pnpm test:eval' }],
  ['install', { category: 'release', command: 'pnpm test:install' }],
  ['capture', { category: 'terminal', command: 'pnpm test:capture' }],
  ['visual', { category: 'terminal', command: 'pnpm capture:visual' }],
  ['independent-review', { category: 'release', command: 'pnpm test:independent-review' }],
  ['release', { category: 'release', command: 'pnpm check:release' }],
])

export const REQUIRED_CHECK_REQUIREMENTS = new Map([
  ['repository', 'AR-09'],
  ['unit', 'AR-03'],
  ['contract', 'AN-04'],
  ['coordination', 'AR-05'],
  ['rpc', 'AR-02'],
  ['rpc-packed', 'VT-03'],
  ['virtual-terminal', 'UX-01'],
  ['pty', 'VT-05'],
  ['storage', 'ST-01'],
  ['crash', 'AR-07'],
  ['security', 'SE-01'],
  ['performance', 'VR-07'],
  ['live-bridge', 'LIVE-01'],
  ['live-tangle', 'LIVE-06'],
  ['live-supervisor', 'LIVE-11'],
  ['live-analysis', 'LIVE-12'],
  ['eval', 'EVAL-01'],
  ['install', 'VR-10'],
  ['capture', 'UX-02'],
  ['visual', 'UX-01'],
  ['independent-review', 'SE-12'],
  ['release', 'VR-01'],
])

export const RELEASE_ASSEMBLY_COMMAND = Object.freeze({
  category: 'release',
  command: 'pnpm verify:release',
})

const LIVE_AGGREGATE_COMMAND = Object.freeze({ category: 'live', command: 'pnpm test:live' })
const LIVE_BRIDGE_RELEASE_COMMAND = Object.freeze({
  category: 'live',
  command: 'pnpm test:live:bridge:release',
})
const UPSTREAM_COMMAND = Object.freeze({ category: 'contract', command: 'pnpm test:upstream' })
const PROPERTY_SOAK_COMMAND = Object.freeze({
  category: 'release',
  command: 'pnpm test:property:soak',
})

export const RELEASE_COMMANDS = new Map()
for (const [id, command] of REQUIRED_CHECKS) {
  if (id === 'live-bridge') RELEASE_COMMANDS.set('live', LIVE_AGGREGATE_COMMAND)
  RELEASE_COMMANDS.set(id, command)
  if (id === 'contract') RELEASE_COMMANDS.set('upstream', UPSTREAM_COMMAND)
  if (id === 'performance') RELEASE_COMMANDS.set('property-soak', PROPERTY_SOAK_COMMAND)
  if (id === 'live-bridge') RELEASE_COMMANDS.set('live-bridge-release', LIVE_BRIDGE_RELEASE_COMMAND)
}
RELEASE_COMMANDS.set('verify:release', RELEASE_ASSEMBLY_COMMAND)

export const EXACT_REQUIREMENT_CHECK_CATEGORIES = new Map([
  ['UP', new Set(['contract'])],
  ['LIVE', new Set(['live'])],
  ['PERF', new Set(['performance'])],
  ['EVAL', new Set(['eval'])],
])
const EXACT_REQUIREMENT_CHECK_IDS = new Map([['VR-03', new Set(['release'])]])

const EXACT_REQUIREMENT_ID = /^(UP|LIVE|PERF|EVAL|VR)-([0-9]{2})$/u

function exactRequirementRoute(prefix, number) {
  if (prefix === 'PERF') return REQUIRED_CHECKS.get('performance')
  if (prefix === 'EVAL') return REQUIRED_CHECKS.get('eval')
  if (prefix === 'LIVE') {
    if (number <= 5) return LIVE_BRIDGE_RELEASE_COMMAND
    if (number <= 10) return REQUIRED_CHECKS.get('live-tangle')
    if (number === 11) return REQUIRED_CHECKS.get('live-supervisor')
    if (number === 12) return REQUIRED_CHECKS.get('live-analysis')
    return undefined
  }
  if (prefix === 'UP') {
    if (number >= 1 && number <= 14) return UPSTREAM_COMMAND
  }
  if (prefix === 'VR' && number === 3) return PROPERTY_SOAK_COMMAND
  return undefined
}

export function exactRequirementCheckCategories(requirementId) {
  const direct = EXACT_REQUIREMENT_CHECK_IDS.get(requirementId)
  if (direct) return direct
  const prefix = requirementId.slice(0, requirementId.indexOf('-'))
  return EXACT_REQUIREMENT_CHECK_CATEGORIES.get(prefix)
}

export function releaseCheckEntry(id) {
  const stable = REQUIRED_CHECKS.get(id)
  if (stable) return stable
  const match = EXACT_REQUIREMENT_ID.exec(id)
  if (!match) return undefined
  return exactRequirementRoute(match[1], Number.parseInt(match[2], 10))
}

export function requiredEvidenceCheckIds(requirementIds) {
  const exact = requirementIds.filter((id) => exactRequirementCheckCategories(id) !== undefined)
  return [...REQUIRED_CHECKS.keys(), ...exact.sort()]
}

export const ADMISSIBLE_CATEGORIES = new Map([
  ['AN', new Set(['unit', 'contract', 'subprocess', 'live', 'security', 'eval'])],
  ['AR', new Set(['unit', 'contract', 'subprocess', 'security', 'release'])],
  ['CF', new Set(['unit', 'contract', 'subprocess', 'live', 'security'])],
  ['EVAL', new Set(['eval'])],
  ['LIVE', new Set(['live'])],
  ['PC', new Set(['unit', 'contract', 'subprocess', 'live', 'security'])],
  ['PERF', new Set(['performance'])],
  [
    'PR',
    new Set(['unit', 'contract', 'subprocess', 'terminal', 'live', 'security', 'eval', 'release']),
  ],
  ['SE', new Set(['contract', 'subprocess', 'live', 'security', 'release'])],
  ['ST', new Set(['unit', 'contract', 'subprocess', 'security', 'performance'])],
  ['UP', new Set(['contract', 'live'])],
  ['US', new Set(['contract', 'security', 'release'])],
  ['UX', new Set(['unit', 'subprocess', 'terminal', 'live', 'security', 'performance'])],
  ['VR', new Set(['subprocess', 'terminal', 'live', 'performance', 'security', 'eval', 'release'])],
  ['VT', new Set(['subprocess', 'terminal', 'release'])],
])
