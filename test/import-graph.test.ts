import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

test('the import graph recognizes every supported TypeScript import form and resolution variant', () => {
  const root = mkdtempSync(join(tmpdir(), 'braid-import-graph-'))
  try {
    const files: Record<string, string> = {
      'entry.ts': [
        "import './side-effect.js'",
        "import type { TypeOnly } from './types.js'",
        "export { Exported } from './exports.js'",
        "const required = require('./required.js')",
        "const dynamic = import('./dynamic.js')",
        "type Imported = import('./type-expression.js').Imported",
        "import './folder.js'",
        "export {\n  Exported\n}\nfrom './tsx.js'",
        "export { Exported } from './module.js'",
        "export { Exported } from './common.js'",
      ].join('\n'),
      'side-effect.ts': '',
      'types.ts': 'export type TypeOnly = string',
      'exports.ts': 'export const Exported = true',
      'required.ts': 'export const required = true',
      'dynamic.ts': 'export const dynamic = true',
      'type-expression.ts': 'export type Imported = string',
      'folder/index.ts': 'export const indexed = true',
      'tsx.tsx': 'export const Exported = true',
      'module.mts': 'export const Exported = true',
      'common.cts': 'export const Exported = true',
    }
    mkdirSync(join(root, 'folder'), { recursive: true })
    for (const [name, source] of Object.entries(files)) {
      const path = join(root, name)
      writeFileSync(path, source)
    }
    const result = spawnSync(
      process.execPath,
      [resolve(process.cwd(), 'scripts/check-import-graph.mjs'), '--root', root, '--no-compare'],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /current: 11 files, 10 relative edges, 0 unresolved, 0 cycles/)

    writeFileSync(join(root, 'added.ts'), 'export const added = true')
    writeFileSync(join(root, 'entry.ts'), `${files['entry.ts']}\nimport './added.js'`)
    const mutated = spawnSync(
      process.execPath,
      [resolve(process.cwd(), 'scripts/check-import-graph.mjs'), '--root', root, '--no-compare'],
      { encoding: 'utf8' },
    )
    assert.equal(mutated.status, 0, mutated.stderr)
    assert.match(mutated.stdout, /current: 12 files, 11 relative edges, 0 unresolved, 0 cycles/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the graph comparison rejects new cycles and enlarged existing cycles', async () => {
  const graphModule = (await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-import-graph.mjs')).href
  )) as {
    buildGraph: (files: Map<string, string>) => unknown
    compareGraphs: (
      base: unknown,
      current: unknown,
    ) => {
      readonly newCycles: readonly unknown[]
      readonly enlargedComponents: readonly unknown[]
    }
  }
  const base = graphModule.buildGraph(
    new Map([
      ['a.ts', "import './b.js'"],
      ['b.ts', "import './a.js'"],
      ['c.ts', ''],
    ]),
  )
  const current = graphModule.buildGraph(
    new Map([
      ['a.ts', "import './b.js'"],
      ['b.ts', "import './a.js'; import './c.js'"],
      ['c.ts', "import './b.js'"],
    ]),
  )
  const comparison = graphModule.compareGraphs(base, current)
  assert.equal(comparison.newCycles.length, 1)
  assert.equal(comparison.enlargedComponents.length, 1)
})
