import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from 'typescript/unstable/ast'
import { assert } from './release-evidence.mjs'

function fail(message) {
  throw new Error(message)
}

function inside(root, target) {
  const location = relative(root, target)
  return location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location)
}

export function parseImportSpecifiers(source, file = '<memory>') {
  const scanner = createScanner(true, LanguageVariant.Standard, source, 0, source.length)
  const tokens = []
  const delimiters = []
  const checkDelimiters = !source.includes('`')
  const templateExpressionDepths = []
  const recordToken = (kind) => {
    tokens.push({ kind, value: scanner.getTokenValue(), lineBreak: scanner.hasPrecedingLineBreak() })
  }
  while (true) {
    const kind = scanner.scan()
    if (
      scanner.isUnterminated() &&
      (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.RegularExpressionLiteral)
    )
      fail(`Cannot parse ${file}: unterminated token`)
    recordToken(kind)
    if (kind === SyntaxKind.EndOfFile) break
    if (kind === SyntaxKind.TemplateHead) templateExpressionDepths.push(0)
    else if (templateExpressionDepths.length > 0 && kind === SyntaxKind.OpenBraceToken)
      templateExpressionDepths[templateExpressionDepths.length - 1] += 1
    else if (templateExpressionDepths.length > 0 && kind === SyntaxKind.CloseBraceToken) {
      const depth = templateExpressionDepths.length - 1
      if (templateExpressionDepths[depth] > 0) templateExpressionDepths[depth] -= 1
      else {
        const templateToken = scanner.reScanTemplateToken(false)
        recordToken(templateToken)
        if (templateToken === SyntaxKind.TemplateTail) templateExpressionDepths.pop()
      }
    }
    if (
      checkDelimiters &&
      (kind === SyntaxKind.OpenBraceToken ||
        kind === SyntaxKind.OpenParenToken ||
        kind === SyntaxKind.OpenBracketToken)
    )
      delimiters.push(kind)
    if (
      checkDelimiters &&
      (kind === SyntaxKind.CloseBraceToken ||
        kind === SyntaxKind.CloseParenToken ||
        kind === SyntaxKind.CloseBracketToken)
    ) {
      const expected = {
        [SyntaxKind.CloseBraceToken]: SyntaxKind.OpenBraceToken,
        [SyntaxKind.CloseParenToken]: SyntaxKind.OpenParenToken,
        [SyntaxKind.CloseBracketToken]: SyntaxKind.OpenBracketToken,
      }[kind]
      if (delimiters.pop() !== expected) fail(`Cannot parse ${file}: unbalanced delimiter`)
    }
  }
  if (templateExpressionDepths.length > 0) fail(`Cannot parse ${file}: unterminated template expression`)
  if (checkDelimiters && delimiters.length > 0) fail(`Cannot parse ${file}: unbalanced delimiter`)
  const specifiers = []
  let braces = 0
  let parentheses = 0
  let brackets = 0
  const addStringAfter = (index) => {
    const token = tokens[index + 1]
    if (token?.kind === SyntaxKind.StringLiteral) specifiers.push(token.value)
  }
  const findFromString = (index) => {
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor]
      if (token.kind === SyntaxKind.SemicolonToken || token.lineBreak && token.kind === SyntaxKind.ExportKeyword)
        return
      if (token.kind === SyntaxKind.FromKeyword) addStringAfter(cursor)
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const previous = tokens[index - 1]
    if (token.kind === SyntaxKind.ImportKeyword && previous?.kind !== SyntaxKind.DotToken) {
      const next = tokens[index + 1]
      if (next?.kind === SyntaxKind.OpenParenToken) addStringAfter(index + 1)
      else if (next?.kind !== SyntaxKind.DotToken && braces === 0 && parentheses === 0 && brackets === 0) {
        if (next?.kind === SyntaxKind.StringLiteral) specifiers.push(next.value)
        else findFromString(index)
      }
    } else if (
      token.kind === SyntaxKind.ExportKeyword &&
      braces === 0 &&
      parentheses === 0 &&
      brackets === 0
    ) findFromString(index)
    if (token.kind === SyntaxKind.OpenBraceToken) braces += 1
    else if (token.kind === SyntaxKind.CloseBraceToken) braces -= 1
    else if (token.kind === SyntaxKind.OpenParenToken) parentheses += 1
    else if (token.kind === SyntaxKind.CloseParenToken) parentheses -= 1
    else if (token.kind === SyntaxKind.OpenBracketToken) brackets += 1
    else if (token.kind === SyntaxKind.CloseBracketToken) brackets -= 1
  }
  return [...new Set(specifiers)]
}

export function resolveLocalImport(root, importer, specifier, files) {
  if (!specifier.startsWith('.')) return undefined
  const target = resolve(dirname(importer), specifier)
  if (!inside(root, target)) fail(`Local import leaves scripts root: ${specifier} from ${importer}`)
  const candidates = [target]
  if (extname(target) === '') candidates.push(`${target}.mjs`, `${target}.js`)
  candidates.push(join(target, 'index.mjs'), join(target, 'index.js'))
  const match = candidates.find((candidate) => files.has(candidate))
  if (!match) fail(`Local import does not resolve: ${specifier} from ${importer}`)
  return match
}

export async function listScriptFiles(root) {
  const files = []
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && extname(entry.name) === '.mjs') files.push(resolve(path))
    }
  }
  await walk(root)
  return files.sort()
}

export async function buildImportGraph(root, files = undefined) {
  const scriptFiles = files ?? (await listScriptFiles(root))
  const fileSet = new Set(scriptFiles.map((path) => resolve(path)))
  const graph = new Map()
  for (const file of scriptFiles) {
    const source = (await readFile(file)).toString('utf8')
    const imports = parseImportSpecifiers(source, file)
    const edges = []
    for (const specifier of imports) {
      const target = resolveLocalImport(root, file, specifier, fileSet)
      if (target !== undefined) edges.push(target)
    }
    graph.set(file, [...new Set(edges)].sort())
  }
  return graph
}

export function stronglyConnectedComponents(graph) {
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
    for (const target of graph.get(node) ?? []) {
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
  for (const node of graph.keys()) if (!indices.has(node)) visit(node)
  return components.sort((left, right) => left[0].localeCompare(right[0]))
}

export function findCycleComponents(graph) {
  return stronglyConnectedComponents(graph).filter(
    (component) =>
      component.length > 1 || (component.length === 1 && graph.get(component[0])?.includes(component[0])),
  )
}

export function runParserSelfTest() {
  const parsed = parseImportSpecifiers(
    "import value from './value.mjs'; export { other } from './other.mjs'; void import('./lazy.mjs')",
    'self-test.mjs',
  )
  assert(
    JSON.stringify(parsed) === JSON.stringify(['./value.mjs', './other.mjs', './lazy.mjs']),
    'Import parser self-test missed a literal import',
  )
  try {
    parseImportSpecifiers('export {', 'invalid-self-test.mjs')
  } catch {
    return
  }
  fail('Import parser self-test accepted invalid syntax')
}

async function main() {
  runParserSelfTest()
  const scriptsRoot = resolve(dirname(fileURLToPath(import.meta.url)))
  const graph = await buildImportGraph(scriptsRoot)
  const components = stronglyConnectedComponents(graph)
  const cycles = findCycleComponents(graph)
  assert(cycles.length === 0, `Import cycles detected: ${cycles.map((cycle) => cycle.join(' -> ')).join('; ')}`)
  const edges = [...graph.values()].reduce((total, targets) => total + targets.length, 0)
  process.stdout.write(
    `Import-cycle check passed: ${graph.size} script modules, ${edges} edges, ${components.length} components, 0 cycles.\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
