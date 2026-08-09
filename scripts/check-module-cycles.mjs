import { readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVirtualFileSystem } from 'typescript/unstable/fs'
import { API } from 'typescript/unstable/sync'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceRoot = join(repositoryRoot, 'src')
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts']
const javascriptSpecifierExtensions = new Map([
  ['.js', sourceExtensions],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
])

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? sourceFiles(path) : [path]
    }),
  )
  return nested
    .flat()
    .filter((path) => sourceExtensions.includes(extname(path)))
    .sort()
}

function isRelativeSpecifier(specifier) {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  )
}

function candidatesFor(raw) {
  const extension = extname(raw)
  if (sourceExtensions.includes(extension)) return [raw]

  const mappedExtensions =
    javascriptSpecifierExtensions.get(extension) ??
    (extension === '' ? sourceExtensions : undefined)
  if (!mappedExtensions) return []

  const base = extension === '' ? raw : raw.slice(0, -extension.length)
  return [
    ...mappedExtensions.map((candidateExtension) => `${base}${candidateExtension}`),
    ...mappedExtensions.map((candidateExtension) => join(base, `index${candidateExtension}`)),
  ]
}

function resolveSpecifier(importer, specifier, modules, root) {
  if (!isRelativeSpecifier(specifier)) return undefined
  const raw = resolve(dirname(importer), specifier)
  const target = candidatesFor(raw).find((candidate) => modules.has(candidate))
  if (!target) {
    throw new Error(
      `Unresolved relative TypeScript import: ${displayPath(root, importer)} -> ${specifier}`,
    )
  }
  return target
}

function displayPath(root, path) {
  const value = relative(root, path)
  return value === '' ? '.' : value
}

function moduleSpecifiers(sourceFile) {
  return sourceFile.imports.map((specifier) => specifier.text)
}

function graphFromFiles(files, root, specifiersForFile) {
  if (files.length === 0) throw new Error('Module graph scan found zero TypeScript modules')
  const modules = new Set(files)
  const graph = new Map(files.map((file) => [file, new Set()]))
  for (const file of files) {
    for (const specifier of specifiersForFile(file)) {
      const target = resolveSpecifier(file, specifier, modules, root)
      if (target) graph.get(file).add(target)
    }
  }
  return graph
}

async function moduleGraph() {
  const files = await sourceFiles(sourceRoot)
  const api = new API({ cwd: repositoryRoot })
  let snapshot
  try {
    snapshot = api.updateSnapshot({ openProjects: [join(repositoryRoot, 'tsconfig.json')] })
    const project = snapshot
      .getProjects()
      .find((candidate) => candidate.program.getSourceFileNames().includes(files[0]))
    if (!project) throw new Error('TypeScript project does not include the src tree')
    return graphFromFiles(files, repositoryRoot, (file) => {
      const sourceFile = project.program.getSourceFile(file)
      if (!sourceFile)
        throw new Error(`TypeScript project did not parse ${displayPath(repositoryRoot, file)}`)
      return moduleSpecifiers(sourceFile)
    })
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

function cyclicComponents(graph) {
  let nextIndex = 0
  const indices = new Map()
  const lowLinks = new Map()
  const stack = []
  const onStack = new Set()
  const components = []

  function visit(node) {
    indices.set(node, nextIndex)
    lowLinks.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)
    for (const target of graph.get(node)) {
      if (!indices.has(target)) {
        visit(target)
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)))
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)))
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return
    const component = []
    let member
    do {
      member = stack.pop()
      onStack.delete(member)
      component.push(member)
    } while (member !== node)
    component.sort()
    if (component.length > 1 || graph.get(component[0]).has(component[0])) {
      components.push(component)
    }
  }

  for (const node of graph.keys()) if (!indices.has(node)) visit(node)
  return components.sort((left, right) => left[0].localeCompare(right[0]))
}

function edgeCount(graph) {
  return [...graph.values()].reduce((total, targets) => total + targets.size, 0)
}

function cycleReport(graph, components, root) {
  const lines = [
    `Module graph: modules=${graph.size}; edges=${edgeCount(graph)}; cyclicSccs=${components.length}`,
  ]
  for (const [index, component] of components.entries()) {
    lines.push(`SCC ${index + 1} (size=${component.length}):`)
    for (const member of component) lines.push(`  ${displayPath(root, member)}`)
    const members = new Set(component)
    lines.push('  internal edges:')
    for (const source of component) {
      for (const target of graph.get(source)) {
        if (members.has(target)) {
          lines.push(`    ${displayPath(root, source)} -> ${displayPath(root, target)}`)
        }
      }
    }
  }
  return lines.join('\n')
}

function assertAcyclic(graph, label, root) {
  const components = cyclicComponents(graph)
  if (components.length > 0) {
    throw new Error(`${label} contains module cycles\n${cycleReport(graph, components, root)}`)
  }
  return components
}

function assertGraphEdges(graph, expected, label) {
  const actual = new Set()
  for (const [source, targets] of graph) {
    for (const target of targets) actual.add(`${source}->${target}`)
  }
  const expectedSet = new Set(expected)
  if (actual.size !== expectedSet.size || [...expectedSet].some((edge) => !actual.has(edge))) {
    throw new Error(
      `${label} parsed edges differ\nexpected=${[...expectedSet].sort().join(',')}\nactual=${[
        ...actual,
      ]
        .sort()
        .join(',')}`,
    )
  }
}

async function selfTestGraph() {
  const root = '/braid-module-cycle-self-test'
  const source = new Map([
    [
      join(root, 'entry.ts'),
      `
        import { value as component } from './component.js'
        import { value as commonjsSource } from './commonjs-source.js'
        import { value as esmSource } from './esm-source.js'
        import './side-effect.js'
        import type { TypeOnly } from './types.js'
        export { value as reexported } from './reexport.js'
        export type { ExportedType } from './export-type.js'
        type Imported = import('./type-expression.js').TypeValue
        void import('./dynamic.js')
        import './directory.js'
        import './extensionless'
        const fakeString = "import './fake-string.js'"
        /* export { fakeComment } from './fake-comment.js' */
        void component
        void commonjsSource
        void esmSource
        void (null as unknown as TypeOnly as Imported)
      `,
    ],
    [join(root, 'component.tsx'), "import './entry.js'\nexport const value = 1"],
    [join(root, 'commonjs-source.cts'), 'export const value = 1'],
    [join(root, 'esm-source.mts'), 'export const value = 1'],
    [join(root, 'side-effect.ts'), 'export const side = true'],
    [join(root, 'types.ts'), 'export type TypeOnly = string'],
    [join(root, 'reexport.ts'), 'export const value = 1'],
    [join(root, 'export-type.ts'), 'export type ExportedType = string'],
    [join(root, 'type-expression.ts'), 'export type TypeValue = string'],
    [join(root, 'dynamic.ts'), 'export const dynamic = true'],
    [join(root, 'directory/index.ts'), 'export const directory = true'],
    [join(root, 'extensionless/index.cts'), 'export const extensionless = true'],
  ])
  const unresolvedFile = join(root, 'unresolved.ts')
  const files = [...source.keys()]
  const virtualFiles = Object.fromEntries([...source, [unresolvedFile, "import './missing.js'"]])
  const api = new API({ cwd: root, fs: createVirtualFileSystem(virtualFiles) })
  let snapshot
  try {
    snapshot = api.updateSnapshot({ openFiles: [...files, unresolvedFile] })
    const project = snapshot.getDefaultProjectForFile(files[0])
    if (!project) throw new Error('Self-test TypeScript project was not created')
    const graph = graphFromFiles(files, root, (file) => {
      const sourceFile = project.program.getSourceFile(file)
      if (!sourceFile) throw new Error(`Self-test source file was not parsed: ${file}`)
      return moduleSpecifiers(sourceFile)
    })
    const entry = join(root, 'entry.ts')
    const component = join(root, 'component.tsx')
    assertGraphEdges(
      graph,
      [
        `${entry}->${component}`,
        `${entry}->${join(root, 'commonjs-source.cts')}`,
        `${entry}->${join(root, 'esm-source.mts')}`,
        `${entry}->${join(root, 'side-effect.ts')}`,
        `${entry}->${join(root, 'types.ts')}`,
        `${entry}->${join(root, 'reexport.ts')}`,
        `${entry}->${join(root, 'export-type.ts')}`,
        `${entry}->${join(root, 'type-expression.ts')}`,
        `${entry}->${join(root, 'dynamic.ts')}`,
        `${entry}->${join(root, 'directory/index.ts')}`,
        `${entry}->${join(root, 'extensionless/index.cts')}`,
        `${component}->${entry}`,
      ],
      'Module-cycle self-test',
    )
    let rejected = false
    try {
      assertAcyclic(graph, 'synthetic source graph', root)
    } catch (error) {
      rejected =
        error instanceof Error &&
        error.message.includes('SCC 1 (size=2)') &&
        error.message.includes('entry.ts') &&
        error.message.includes('component.tsx')
    }
    if (!rejected) {
      throw new Error(
        'Module-cycle self-test did not reject the parsed and resolved synthetic cycle',
      )
    }
    let unresolvedRejected = false
    try {
      graphFromFiles([unresolvedFile], root, (file) => {
        const sourceFile = project.program.getSourceFile(file)
        if (!sourceFile) throw new Error(`Self-test source file was not parsed: ${file}`)
        return moduleSpecifiers(sourceFile)
      })
    } catch (error) {
      unresolvedRejected =
        error instanceof Error && error.message.includes('Unresolved relative TypeScript import')
    }
    if (!unresolvedRejected) throw new Error('Module-cycle self-test accepted an unresolved import')
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

async function main() {
  const selfTest = process.argv.includes('--self-test')
  if (selfTest) await selfTestGraph()
  const graph = await moduleGraph()
  const components = assertAcyclic(graph, 'src', repositoryRoot)
  process.stdout.write(
    `${cycleReport(graph, components, repositoryRoot)}${
      selfTest ? '; selfTest=parsed-resolved-cycle-rejected; real-graph=accepted' : ''
    }\n`,
  )
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
