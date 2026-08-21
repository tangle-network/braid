import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { AGENT_EVAL_VERSION } from '../src/adapters/analysis/agent-eval-version.js'
import { AGENT_RUNTIME_VERSION } from '../src/adapters/runtime/agent-runtime-version.js'

const require = createRequire(import.meta.url)

function installedVersion(packageName: string): string {
  const entry = require.resolve(packageName)
  const document = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
    readonly version: string
  }
  return document.version
}

test('runtime evidence reads the installed package versions', () => {
  assert.equal(AGENT_RUNTIME_VERSION, installedVersion('@tangle-network/agent-runtime'))
  assert.equal(AGENT_EVAL_VERSION, installedVersion('@tangle-network/agent-eval'))
})
