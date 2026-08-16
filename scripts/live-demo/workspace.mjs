import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LIVE_DEMO_PROFILE = Object.freeze({
  name: 'Release engineer',
  description: 'Implements one bounded change and proves it with tests.',
  harness: 'pi',
  model: {
    default: 'openai-codex/gpt-5.6-luna',
    provider: 'openai-codex',
    reasoningEffort: 'high',
    maxVisibleOutputTokens: 32768,
    maxReasoningTokens: 65536,
    maxTotalOutputTokens: 98304,
  },
  prompt: {
    instructions: [
      'Inspect the repository before changing it.',
      'Make the smallest complete change.',
      'Run the relevant tests and report the exact result.',
    ],
  },
})

export const LIVE_DEMO_ANALYST_PROFILE = Object.freeze({
  name: 'Trace analyst',
  description: 'Reviews a completed run and cites the retained execution evidence.',
  harness: 'pi',
  model: {
    default: 'openai-codex/gpt-5.6-luna',
    provider: 'openai-codex',
    reasoningEffort: 'high',
    maxVisibleOutputTokens: 16384,
    maxReasoningTokens: 32768,
    maxTotalOutputTokens: 49152,
  },
  prompt: {
    instructions: [
      'Base every finding on the retained execution evidence.',
      'Cite the exact evidence that supports each finding.',
      'Separate verified facts from recommendations.',
    ],
  },
})

export const LIVE_DEMO_PROMPT =
  'Finish the slugify function. Normalize Unicode accents, treat underscores as punctuation, collapse punctuation and spaces to one dash, trim dashes, and lowercase. Add edge-case tests, run them, and summarize the proof.'

export const LIVE_DEMO_QUESTION = 'What changed, what was verified, and what should I review?'

/** Build the public demo profile from the route the live bridge actually advertises. */
export function liveDemoProfileForRoute(route, baseProfile = LIVE_DEMO_PROFILE) {
  const parts = route.split('/')
  const runner = parts.shift()
  if (
    runner !== baseProfile.harness ||
    parts.length === 0 ||
    parts.some((part) => part.length === 0)
  )
    throw new Error(`Live demo route must start with ${baseProfile.harness}/: ${route}`)
  const provider = parts.length > 1 ? parts.shift() : undefined
  const model = parts.join('/')
  if (model.length === 0) throw new Error(`Live demo route has no model: ${route}`)
  return Object.freeze({
    ...baseProfile,
    model: Object.freeze({
      ...baseProfile.model,
      default: model,
      ...(provider === undefined ? { provider: undefined } : { provider }),
    }),
  })
}

export async function createLiveDemoWorkspace(
  root,
  { profile = LIVE_DEMO_PROFILE, analystProfile = LIVE_DEMO_ANALYST_PROFILE } = {},
) {
  const workspace = join(root, 'braid-demo')
  const sourceRoot = join(workspace, 'src')
  const testRoot = join(workspace, 'test')
  const profileRoot = join(workspace, '.braid')
  await Promise.all([
    mkdir(sourceRoot, { recursive: true, mode: 0o700 }),
    mkdir(testRoot, { recursive: true, mode: 0o700 }),
    mkdir(profileRoot, { recursive: true, mode: 0o700 }),
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
    writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(profileRoot, 'profile.json'), `${JSON.stringify(analystProfile, null, 2)}\n`, {
      mode: 0o600,
    }),
  ])
  return { workspace, profilePath }
}
