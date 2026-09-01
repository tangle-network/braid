import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'

const repositoryRoot = resolve(process.cwd())
const componentIndex = join(repositoryRoot, 'docs/components/README.md')
const sourceDirectories = ['src/adapters/tui', 'src/views/tui'] as const

interface DocumentedComponent {
  readonly name: string
  readonly source: string
  readonly document: string
}

function exportedTerminalComponents(): readonly Omit<DocumentedComponent, 'document'>[] {
  const components: Omit<DocumentedComponent, 'document'>[] = []
  for (const sourceDirectory of sourceDirectories) {
    const absoluteDirectory = join(repositoryRoot, sourceDirectory)
    for (const filename of readdirSync(absoluteDirectory).filter((name) => name.endsWith('.ts'))) {
      const absolutePath = join(absoluteDirectory, filename)
      const source = relative(repositoryRoot, absolutePath).split('\\').join('/')
      const text = readFileSync(absolutePath, 'utf8')
      for (const match of text.matchAll(/^export class ([A-Za-z][A-Za-z0-9_]*)/gmu)) {
        const name = match[1]
        if (name !== undefined) components.push({ name, source })
      }
    }
  }
  return components.sort((left, right) =>
    `${left.source}:${left.name}`.localeCompare(`${right.source}:${right.name}`),
  )
}

function documentedTerminalComponents(): readonly DocumentedComponent[] {
  const text = readFileSync(componentIndex, 'utf8')
  const components: DocumentedComponent[] = []
  const row = /^\| `([^`]+)` \| `([^`]+)` \| \[[^\]]+\]\(([^)]+)\) \|$/gmu
  for (const match of text.matchAll(row)) {
    const [, name, source, document] = match
    if (name !== undefined && source !== undefined && document !== undefined) {
      components.push({ name, source, document })
    }
  }
  return components.sort((left, right) =>
    `${left.source}:${left.name}`.localeCompare(`${right.source}:${right.name}`),
  )
}

test('every exported terminal component maps to one existing design document', () => {
  const exported = exportedTerminalComponents()
  const documented = documentedTerminalComponents()
  const documentedKeys = documented.map(({ name, source }) => `${source}:${name}`)

  assert.equal(new Set(documentedKeys).size, documentedKeys.length)
  assert.deepEqual(
    documented.map(({ name, source }) => ({ name, source })),
    exported,
  )

  for (const component of documented) {
    assert.ok(
      existsSync(join(dirname(componentIndex), component.document)),
      `${component.name} references missing ${component.document}`,
    )
  }
})

test('every product component states its best simple implementation', () => {
  const directory = dirname(componentIndex)
  const documents = readdirSync(directory)
    .filter((filename) => filename.endsWith('.md') && filename !== 'README.md')
    .sort()

  assert.ok(documents.length > 0)
  for (const document of documents) {
    const text = readFileSync(join(directory, document), 'utf8')
    assert.match(
      text,
      /^## Best simple implementation$/mu,
      `${document} must state its best simple implementation`,
    )
  }
})
