import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJson = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
)

test('W5 exposes stable checks for every requested release surface', () => {
  const required = [
    'test:unit',
    'test:contract',
    'test:coordination',
    'test:rpc',
    'test:virtual-terminal',
    'test:pty',
    'test:storage',
    'test:crash',
    'test:security',
    'test:performance',
    'test:live',
    'test:install',
    'test:capture',
    'check:release',
  ]
  for (const script of required) assert.equal(typeof packageJson.scripts[script], 'string', script)
})

test('the scoped test runner rejects an unregistered scope instead of silently running the wrong suite', async () => {
  const source = await readFile(new URL('../../scripts/run-tests.mjs', import.meta.url), 'utf8')
  assert.match(source, /No compiled tests registered for scope/u)
  assert.match(source, /scopeFiles/u)
})
