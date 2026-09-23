import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LanguageVariant, SyntaxKind } from 'typescript/unstable/ast'
import { createScanner } from 'typescript/unstable/ast/scanner'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const JAVASCRIPT_EXTENSIONS = new Map([
  ['.js', SOURCE_EXTENSIONS],
  ['.mjs', ['.mts', '.ts', '.tsx', '.cts']],
  ['.cjs', ['.cts', '.ts', '.tsx', '.mts']],
])

export function parseImports(source, fileName = 'file.ts') {
  const scanner = createScanner(
    true,
    fileName.endsWith('.tsx') ? LanguageVariant.JSX : LanguageVariant.Standard,
    source,
  )
  const lineStarts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1)
  }
  const tokens = []
  for (;;) {
    const kind = scanner.scan()
    if (kind === SyntaxKind.EndOfFile) break
    tokens.push({
      kind,
      line: lineAt(lineStarts, scanner.getTokenStart()),
      start: scanner.getTokenStart(),
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
    })
  }
  const imports = []
  const add = (token, specifier, kind) => {
    if (specifier !== undefined) imports.push({ kind, line: token.line, specifier })
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind === SyntaxKind.ImportKeyword) {
      if (tokens[index + 1]?.kind === SyntaxKind.OpenParenToken) {
        add(token, stringValue(tokens[index + 2]), 'dynamic-import')
      } else {
        add(token, declarationSource(tokens, index + 1), 'import')
      }
    } else if (token.kind === SyntaxKind.ExportKeyword) {
      add(token, declarationSource(tokens, index + 1), 'export-from')
    } else if (
      (token.kind === SyntaxKind.RequireKeyword || token.text === 'require') &&
      tokens[index - 1]?.kind !== SyntaxKind.DotToken &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken
    ) {
      add(token, stringValue(tokens[index + 2]), 'require')
    }
  }
  return imports
}

export function buildGraph(files) {
  const names = [...files.keys()].map(normalizePath).sort()
  const fileSet = new Set(names)
  const edges = new Map(names.map((name) => [name, new Set()]))
  const unresolved = []
  const imports = new Map()
  for (const name of names) {
    const found = parseImports(files.get(name), name)
    imports.set(name, found)
    for (const entry of found) {
      if (!entry.specifier.startsWith('.')) continue
      const target = resolveSource(name, entry.specifier, fileSet)
      if (target === undefined) {
        unresolved.push({ file: name, ...entry })
        continue
      }
      edges.get(name).add(target)
    }
  }
  return { nodes: names, edges, imports, unresolved }
}

export function stronglyConnectedComponents(graph) {
  let index = 0
  const indices = new Map()
  const lowLinks = new Map()
  const stack = []
  const onStack = new Set()
  const components = []
  const visit = (node) => {
    indices.set(node, index)
    lowLinks.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)
    for (const target of graph.edges.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target)
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)))
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)))
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return
    const component = []
    let target
    do {
      target = stack.pop()
      onStack.delete(target)
      component.push(target)
    } while (target !== node)
    components.push(component.sort())
  }
  for (const node of graph.nodes) if (!indices.has(node)) visit(node)
  return components.sort((left, right) => left[0].localeCompare(right[0]))
}

export function compareGraphs(base, current) {
  const baseCycles = cyclicComponents(base)
  const currentCycles = cyclicComponents(current)
  const newCycles = currentCycles.filter(
    (currentCycle) => !baseCycles.some((baseCycle) => sameSet(baseCycle, currentCycle)),
  )
  const enlargedComponents = baseCycles.flatMap((baseCycle) => {
    const currentComponent = currentCycles.find((candidate) =>
      baseCycle.every((node) => candidate.includes(node)),
    )
    return currentComponent && currentComponent.length > baseCycle.length
      ? [{ before: baseCycle, after: currentComponent }]
      : []
  })
  return { baseCycles, currentCycles, newCycles, enlargedComponents }
}

export function resolveSource(from, specifier, files) {
  const base = normalizePath(join(dirname(from), specifier))
  const extension = extname(base)
  const candidates = []
  if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    const stem = base.slice(0, -extension.length)
    for (const candidateExtension of JAVASCRIPT_EXTENSIONS.get(extension)) {
      candidates.push(`${stem}${candidateExtension}`)
    }
  } else if (SOURCE_EXTENSIONS.includes(extension)) {
    candidates.push(base)
  } else if (!extension) {
    for (const candidateExtension of SOURCE_EXTENSIONS) {
      candidates.push(`${base}${candidateExtension}`)
    }
  }
  if (
    extension &&
    !JAVASCRIPT_EXTENSIONS.has(extension) &&
    !SOURCE_EXTENSIONS.includes(extension)
  ) {
    candidates.push(base)
  }
  if (!extension || JAVASCRIPT_EXTENSIONS.has(extension)) {
    const stem = JAVASCRIPT_EXTENSIONS.has(extension) ? base.slice(0, -extension.length) : base
    for (const candidateExtension of SOURCE_EXTENSIONS) {
      candidates.push(`${stem}/index${candidateExtension}`)
    }
  } else if (SOURCE_EXTENSIONS.includes(extension)) {
    candidates.push(`${base.slice(0, -extension.length)}/index${extension}`)
  }
  return candidates.find((candidate) => files.has(normalizePath(candidate)))
}

function cyclicComponents(graph) {
  return stronglyConnectedComponents(graph).filter(
    (component) =>
      component.length > 1 ||
      (component.length === 1 && graph.edges.get(component[0])?.has(component[0])),
  )
}

function sameSet(left, right) {
  return left.length === right.length && left.every((node, index) => node === right[index])
}

function declarationSource(tokens, start) {
  if (stringValue(tokens[start]) !== undefined) return stringValue(tokens[start])
  let braceDepth = 0
  let parenDepth = 0
  let bracketDepth = 0
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]
    const previous = tokens[index - 1]
    if (
      index > start &&
      !braceDepth &&
      !parenDepth &&
      !bracketDepth &&
      token.line > previous.line &&
      previous.kind === SyntaxKind.CloseBraceToken &&
      token.text !== 'from'
    ) {
      return undefined
    }
    if (token.kind === SyntaxKind.SemicolonToken && !braceDepth && !parenDepth && !bracketDepth) {
      return undefined
    }
    if (token.kind === SyntaxKind.OpenBraceToken) braceDepth += 1
    else if (token.kind === SyntaxKind.CloseBraceToken) braceDepth -= 1
    else if (token.kind === SyntaxKind.OpenParenToken) parenDepth += 1
    else if (token.kind === SyntaxKind.CloseParenToken) parenDepth -= 1
    else if (token.kind === SyntaxKind.OpenBracketToken) bracketDepth += 1
    else if (token.kind === SyntaxKind.CloseBracketToken) bracketDepth -= 1
    else if (token.text === 'from' && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      return stringValue(tokens[index + 1])
    }
  }
  return undefined
}

function stringValue(token) {
  return token &&
    (token.kind === SyntaxKind.StringLiteral ||
      token.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
    ? token.value
    : undefined
}

function lineAt(starts, position) {
  let low = 0
  let high = starts.length
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (starts[middle] <= position) low = middle
    else high = middle
  }
  return low + 1
}

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '')
}

function readTree(root) {
  const files = new Map()
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !SOURCE_EXTENSIONS.includes(extname(entry.name))) continue
    const fullPath = resolve(entry.parentPath ?? root, entry.name)
    files.set(normalizePath(relative(root, fullPath)), readFileSync(fullPath, 'utf8'))
  }
  return files
}

function readGitTree(base, root) {
  const files = new Map()
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base, '--', root], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
  for (const path of paths) {
    if (!SOURCE_EXTENSIONS.includes(extname(path))) continue
    files.set(
      normalizePath(path.slice(`${root}/`.length)),
      execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8' }),
    )
  }
  return files
}

function graphSummary(label, graph) {
  const edgeCount = [...graph.edges.values()].reduce((count, targets) => count + targets.size, 0)
  const cycleCount = cyclicComponents(graph).length
  return `${label}: ${graph.nodes.length} files, ${edgeCount} relative edges, ${graph.unresolved.length} unresolved, ${cycleCount} cycles`
}

function main() {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]
    if (argument === '--no-compare') args.set(argument, true)
    else if (argument.startsWith('--')) args.set(argument, process.argv[++index])
  }
  const root = resolve(process.cwd(), args.get('--root') ?? 'src')
  const current = buildGraph(readTree(root))
  console.log(graphSummary('current', current))
  if (current.unresolved.length) {
    for (const entry of current.unresolved) {
      console.error(
        `${entry.file}:${entry.line} ${entry.kind} ${entry.specifier} cannot be resolved`,
      )
    }
    process.exitCode = 1
    return
  }
  if (args.has('--no-compare')) return
  const baseName = args.get('--base') ?? 'HEAD'
  const base = buildGraph(readGitTree(baseName, relative(process.cwd(), root)))
  console.log(graphSummary(baseName, base))
  const comparison = compareGraphs(base, current)
  for (const cycle of comparison.newCycles) {
    console.error(`new cycle: ${cycle.join(' -> ')}`)
  }
  for (const component of comparison.enlargedComponents) {
    console.error(`enlarged cycle: ${component.before.join(', ')} -> ${component.after.join(', ')}`)
  }
  if (comparison.newCycles.length || comparison.enlargedComponents.length) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
