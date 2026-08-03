import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

export const MODULE_SIZE_LIMIT = 500

export const MODULE_ROOTS = [
  {
    relativePath: 'src',
    extensions: new Set(['.ts', '.tsx']),
    label: 'production TypeScript',
  },
  {
    relativePath: 'scripts',
    extensions: new Set(['.mjs', '.js']),
    label: 'release JavaScript',
  },
]

export function countLines(contents) {
  if (contents.length === 0) return 0
  const lines = contents.split(/\r\n|\r|\n/u).length
  return lines - Number(/(?:\r\n|\r|\n)$/u.test(contents))
}

export async function filesBelow(root, extensions) {
  const files = []
  const entries = (await readdir(root, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await filesBelow(path, extensions)))
    else if (entry.isFile() && extensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

export async function findModuleSizeViolations({
  repository,
  roots = MODULE_ROOTS,
  limit = MODULE_SIZE_LIMIT,
}) {
  const violations = []
  for (const root of roots) {
    const rootPath = join(repository, root.relativePath)
    for (const path of await filesBelow(rootPath, root.extensions)) {
      const lines = countLines(await readFile(path, 'utf8'))
      if (lines > limit) {
        violations.push({
          path: relative(repository, path),
          lines,
          limit,
          label: root.label,
        })
      }
    }
  }
  return violations
}

export function formatModuleSizeFailure(violations) {
  return `Module size check failed:\n${violations
    .map(({ path, lines, limit }) => `${path}: ${lines} lines (limit ${limit})`)
    .join('\n')}`
}
