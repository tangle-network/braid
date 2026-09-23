export const REQUIREMENT_PATTERN = /\b[A-Z]{2,4}-[0-9]{2}\b/gu
export const REQUIREMENT_PREFIXES = Object.freeze([
  'PR',
  'UX',
  'AR',
  'UP',
  'PC',
  'CF',
  'AN',
  'SE',
  'ST',
  'VT',
  'LIVE',
  'PERF',
  'EVAL',
  'VR',
  'US',
])
export const EXPECTED_REQUIREMENT_COUNT = 154
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
  ['rpc', { category: 'subprocess', command: 'pnpm test:rpc' }],
  ['virtual-terminal', { category: 'terminal', command: 'pnpm test:virtual-terminal' }],
  ['pty', { category: 'terminal', command: 'pnpm test:pty' }],
  ['storage', { category: 'contract', command: 'pnpm test:storage' }],
  ['security', { category: 'security', command: 'pnpm test:security' }],
  ['performance', { category: 'performance', command: 'pnpm test:performance' }],
  ['live-bridge', { category: 'live', command: 'pnpm test:live:bridge' }],
  ['live-tangle', { category: 'live', command: 'pnpm test:live:tangle' }],
  ['live-supervisor', { category: 'live', command: 'pnpm test:live:supervisor' }],
  ['live-analysis', { category: 'live', command: 'pnpm test:live:analysis' }],
  ['eval', { category: 'eval', command: 'pnpm test:eval' }],
  ['install', { category: 'release', command: 'pnpm test:install' }],
  ['visual', { category: 'terminal', command: 'pnpm capture:visual' }],
  ['verify:release', { category: 'release', command: 'pnpm verify:release' }],
])

export const REQUIRED_CHECK_REQUIREMENTS = new Map([
  ['repository', 'AR-01'],
  ['unit', 'AR-03'],
  ['contract', 'UP-01'],
  ['rpc', 'VT-03'],
  ['virtual-terminal', 'VT-01'],
  ['pty', 'VT-05'],
  ['storage', 'ST-01'],
  ['security', 'SE-01'],
  ['performance', 'PERF-01'],
  ['live-bridge', 'LIVE-01'],
  ['live-tangle', 'LIVE-06'],
  ['live-supervisor', 'LIVE-11'],
  ['live-analysis', 'LIVE-12'],
  ['eval', 'EVAL-01'],
  ['install', 'VR-10'],
  ['visual', 'UX-01'],
  ['verify:release', 'VR-01'],
])

export const EXACT_REQUIREMENT_CHECK_CATEGORIES = new Map([
  ['UP', new Set(['contract', 'live'])],
  ['LIVE', new Set(['live'])],
  ['PERF', new Set(['performance'])],
  ['EVAL', new Set(['eval'])],
])

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
  ['ST', new Set(['unit', 'contract', 'security', 'performance'])],
  ['UP', new Set(['contract', 'live'])],
  ['US', new Set(['contract', 'security', 'release'])],
  ['UX', new Set(['unit', 'subprocess', 'terminal', 'live', 'security', 'performance'])],
  ['VR', new Set(['terminal', 'live', 'performance', 'security', 'eval', 'release'])],
  ['VT', new Set(['subprocess', 'terminal', 'release'])],
])

export const REFERENCE_SIZES = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
]

export const REQUIRED_VISUAL_STATES = [
  'empty',
  'active-streaming',
  'interaction',
  'fork-preview',
  'graph-or-analysis',
  'narrow',
  'failure-or-reconnect',
]
