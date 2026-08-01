import { execFileSync } from 'node:child_process'

const graph = JSON.parse(
  execFileSync('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json'], {
    cwd: new URL('../', import.meta.url),
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

if (violations.length > 0) {
  process.stderr.write(`Forbidden dependency graph entries:\n${violations.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `Production dependency graph: ${packages.size} packages; Pi TUI present; no copied agent application\n`,
  )
}
