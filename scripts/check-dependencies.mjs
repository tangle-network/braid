import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)

const graph = JSON.parse(
  execFileSync('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  }),
)

const packages = new Set()
function visitDependencies(node) {
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    packages.add(name)
    visitDependencies(dependency)
  }
}
for (const root of graph) visitDependencies(root)

const forbidden = [
  '@earendil-works/pi-coding-agent',
  '@moonshot-ai/kimi-cli',
  '@opencode-ai/',
  '@nousresearch/hermes',
]
const violations = [...packages].filter((name) =>
  forbidden.some((candidate) => name === candidate || name.startsWith(candidate)),
)

if (!packages.has('@earendil-works/pi-tui')) {
  violations.push('missing @earendil-works/pi-tui')
}

const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const runtimeContracts = readFileSync(new URL('docs/04-runtime-contracts.md', root), 'utf8')
const documentedCohort = [
  '@tangle-network/agent-interface',
  '@tangle-network/agent-runtime',
  '@tangle-network/agent-eval',
  '@tangle-network/agent-provider-cli-bridge',
  '@tangle-network/agent-provider-tangle',
  '@tangle-network/sandbox',
]
for (const name of documentedCohort) {
  const expected = manifest.dependencies?.[name]
  const row = runtimeContracts
    .split('\n')
    .find((line) => line.startsWith('|') && line.split('|')[1]?.includes(name))
  const documented = row?.split('|')[2]?.trim().replaceAll('`', '')
  if (typeof expected !== 'string') {
    violations.push(`missing direct dependency ${name}`)
  } else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(expected)) {
    violations.push(`${name} must use an exact version; found ${expected}`)
  } else if (documented !== expected) {
    violations.push(`${name} documentation is ${documented ?? 'missing'}; expected ${expected}`)
  }
}

if (violations.length > 0) {
  process.stderr.write(`Dependency checks failed:\n${violations.join('\n')}\n`)
  process.exitCode = 1
  process.exit()
}

try {
  execFileSync('pnpm', ['audit', '--prod', '--audit-level', 'high'], {
    cwd: root,
    stdio: 'inherit',
  })
} catch {
  process.stderr.write('Production dependency audit found a high or critical vulnerability\n')
  process.exitCode = 1
}

if (process.exitCode !== 1)
  process.stdout.write(
    `Production dependency graph: ${packages.size} packages; documented cohort matches; Pi TUI present; no copied agent application; no high or critical audit finding\n`,
  )
