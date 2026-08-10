import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LIVE_DEMO_PROFILE = Object.freeze({
  name: 'Product engineer',
  description: 'Implements one bounded change and proves it with tests.',
  harness: 'pi',
  model: {
    provider: 'tangle-router',
    default: 'tangle-router/glm-5.2',
    reasoningEffort: 'high',
    metadata: { maxTokens: 16384 },
  },
  prompt: {
    instructions: [
      'Inspect the repository before changing it.',
      'Make the smallest complete change.',
      'Run the relevant tests and report the exact result.',
    ],
  },
  tools: { read: true, write: true, shell: true },
  permissions: { read: 'allow', write: 'allow', shell: 'allow' },
})

export const LIVE_DEMO_PROMPT =
  'Finish the slugify function. Normalize Unicode accents, collapse punctuation and spaces to one dash, trim dashes, and lowercase. Add edge-case tests, run them, and summarize the proof.'

export const LIVE_DEMO_QUESTION = 'What changed, what was verified, and what should I review?'

export async function createLiveDemoWorkspace(root) {
  const workspace = join(root, 'braid-demo')
  const sourceRoot = join(workspace, 'src')
  const testRoot = join(workspace, 'test')
  await Promise.all([
    mkdir(sourceRoot, { recursive: true, mode: 0o700 }),
    mkdir(testRoot, { recursive: true, mode: 0o700 }),
  ])
  const profilePath = join(workspace, 'braid.profile.json')
  await Promise.all([
    writeFile(
      join(workspace, 'package.json'),
      `${JSON.stringify(
        {
          name: 'braid-live-demo-workspace',
          private: true,
          type: 'module',
          scripts: { test: 'node --test' },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(sourceRoot, 'slugify.js'),
      [
        'export function slugify(value) {',
        "  return value.toLowerCase().replaceAll(' ', '-')",
        '}',
        '',
      ].join('\n'),
      { mode: 0o600 },
    ),
    writeFile(
      join(testRoot, 'slugify.test.js'),
      [
        "import assert from 'node:assert/strict'",
        "import test from 'node:test'",
        "import { slugify } from '../src/slugify.js'",
        '',
        "test('joins words with a dash', () => {",
        "  assert.equal(slugify('Hello world'), 'hello-world')",
        '})',
        '',
      ].join('\n'),
      { mode: 0o600 },
    ),
    writeFile(profilePath, `${JSON.stringify(LIVE_DEMO_PROFILE, null, 2)}\n`, { mode: 0o600 }),
  ])
  return { workspace, profilePath }
}
