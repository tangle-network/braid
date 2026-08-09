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
  ['live', { category: 'live', command: 'pnpm test:live' }],
  ['live-bridge', { category: 'live', command: 'pnpm test:live:bridge' }],
  ['live-tangle', { category: 'live', command: 'pnpm test:live:tangle' }],
  ['live-supervisor', { category: 'live', command: 'pnpm test:live:supervisor' }],
  ['live-analysis', { category: 'live', command: 'pnpm test:live:analysis' }],
  ['eval', { category: 'eval', command: 'pnpm test:eval' }],
  ['install', { category: 'release', command: 'pnpm test:install' }],
  ['capture', { category: 'terminal', command: 'pnpm test:capture' }],
  ['visual', { category: 'terminal', command: 'pnpm capture:visual' }],
  ['release', { category: 'release', command: 'pnpm check:release' }],
])

export const RELEASE_ASSEMBLY_COMMAND = Object.freeze({
  category: 'release',
  command: 'pnpm verify:release',
})

export const RELEASE_COMMANDS = new Map([
  ...REQUIRED_CHECKS,
  ['verify:release', RELEASE_ASSEMBLY_COMMAND],
])

export const EXACT_REQUIREMENT_CHECK_CATEGORIES = new Map([
  ['UP', new Set(['contract', 'live'])],
  ['LIVE', new Set(['live'])],
  ['PERF', new Set(['performance'])],
  ['EVAL', new Set(['eval'])],
])

const EXACT_REQUIREMENT_ID = /^(UP|LIVE|PERF|EVAL)-([0-9]{2})$/u

function exactRequirementRoute(prefix, number) {
  if (prefix === 'PERF') return REQUIRED_CHECKS.get('performance')
  if (prefix === 'EVAL') return REQUIRED_CHECKS.get('eval')
  if (prefix === 'LIVE') {
    if (number <= 5) return REQUIRED_CHECKS.get('live-bridge')
    if (number <= 10) return REQUIRED_CHECKS.get('live-tangle')
    if (number === 11) return REQUIRED_CHECKS.get('live-supervisor')
    if (number === 12) return REQUIRED_CHECKS.get('live-analysis')
    return undefined
  }
  if (prefix === 'UP') {
    if (number === 8) return REQUIRED_CHECKS.get('live-bridge')
    if (number === 9 || number === 14) return REQUIRED_CHECKS.get('live-tangle')
    if (number >= 1 && number <= 14) return REQUIRED_CHECKS.get('contract')
  }
  return undefined
}

export function releaseCheckEntry(id) {
  const stable = REQUIRED_CHECKS.get(id)
  if (stable) return stable
  const match = EXACT_REQUIREMENT_ID.exec(id)
  if (!match) return undefined
  return exactRequirementRoute(match[1], Number.parseInt(match[2], 10))
}

export function requiredEvidenceCheckIds(requirementIds) {
  const exact = requirementIds.filter((id) => {
    const prefix = id.slice(0, id.indexOf('-'))
    return EXACT_REQUIREMENT_CHECK_CATEGORIES.has(prefix)
  })
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
