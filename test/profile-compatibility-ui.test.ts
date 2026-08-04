import assert from 'node:assert/strict'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { TUI, visibleWidth } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { createProfileRecord } from '../src/app/profiles.js'
import {
  ProfileCompatibilityPanel,
  type ProfileCompatibilityResult,
  profileCompatibilityTextLines,
} from '../src/views/tui/profile-compatibility.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for profile compatibility UI')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function incompatibleResult(
  overrides: Partial<ProfileCompatibilityResult> = {},
): ProfileCompatibilityResult {
  return {
    authoredProfile: { name: 'release profile' },
    runner: 'codex',
    model: 'zai/glm-5.2',
    compatibility: {
      modelSupported: false,
      suggestedRunner: 'opencode',
      suggestedModel: 'openai/gpt-5.6-luna',
    },
    ...overrides,
  }
}

test('names the exact unsupported pair, preserves the profile, and offers both choices', () => {
  const text = profileCompatibilityTextLines(incompatibleResult(), 80).join('\n')

  assert.match(text, /harness=codex/)
  assert.match(text, /model=zai\/glm-5\.2/)
  assert.match(text, /authored profile "release profile" remains unchanged/)
  assert.match(text, /change runner to opencode to keep model zai\/glm-5\.2/)
  assert.match(text, /change model to openai\/gpt-5\.6-luna to keep runner codex/)
})

test('sanitizes every untrusted value before terminal rendering', () => {
  const result = incompatibleResult({
    authoredProfile: { name: 'profile\u001b]0;owned\u0007\u202ename' },
    runner: 'codex\u001b[31m',
    model: 'zai/glm-5.2\rspoof',
    compatibility: {
      modelSupported: false,
      suggestedRunner: 'opencode\u001b[0m',
      suggestedModel: 'openai/gpt-5.6-luna\u202e',
    },
  })
  const text = profileCompatibilityTextLines(result, 80).join('\n')

  assert.equal(text.includes('\u001b'), false)
  assert.equal(text.includes('\u202e'), false)
  assert.equal(text.includes('\r'), false)
  assert.match(text, /profilename/)
})

test('wraps all output without losing exact values at 40 and 80 columns', () => {
  const result = incompatibleResult()
  for (const width of [40, 80]) {
    const lines = profileCompatibilityTextLines(result, width)
    assert.ok(lines.length > 0)
    assert.ok(lines.every((line) => visibleWidth(line) <= width))
    const text = lines.join('\n')
    assert.match(text, /harness=codex/)
    assert.match(text, /model=zai\/glm-5\.2/)
    assert.match(text, /change runner to opencode/)
    assert.match(text, /change model to openai\/gpt-5\.6-luna/)
  }

  const panel = new ProfileCompatibilityPanel(result)
  assert.deepEqual(panel.render(40), profileCompatibilityTextLines(result, 40))
})

test('fails closed without complete fields or suggestions', () => {
  const incomplete: readonly ProfileCompatibilityResult[] = [
    incompatibleResult({ authoredProfile: undefined }),
    incompatibleResult({ runner: undefined }),
    incompatibleResult({ model: undefined }),
    incompatibleResult({ compatibility: { modelSupported: false } }),
    incompatibleResult({
      compatibility: { modelSupported: false, suggestedRunner: 'opencode' },
    }),
  ]

  for (const result of incomplete) {
    const text = profileCompatibilityTextLines(result, 40).join('\n')
    assert.match(text, /compatibility unavailable/)
    assert.match(text, /authored profile remains unchanged/)
    assert.doesNotMatch(text, /change runner to/)
    assert.doesNotMatch(text, /change model to/)
  }
})

test('does not offer recovery choices when the pair is already supported', () => {
  const text = profileCompatibilityTextLines(
    incompatibleResult({
      compatibility: { modelSupported: true },
    }),
    80,
  ).join('\n')

  assert.match(text, /supported pair: harness=codex · model=zai\/glm-5\.2/)
  assert.match(text, /authored profile "release profile" remains unchanged/)
  assert.doesNotMatch(text, /change runner to/)
  assert.doesNotMatch(text, /change model to/)
})

test('profile validation reaches the same mismatch presenter through real terminal keys', async () => {
  const incompatible = defineAgentProfile({
    name: 'GLM through Codex',
    harness: 'codex',
    model: { default: 'zai/glm-5.2' },
  })
  const compatibleModel = defineAgentProfile({
    name: 'Luna through Codex',
    harness: 'codex',
    model: { default: 'openai/gpt-5.6-luna' },
  })
  const incompatibleRecord = createProfileRecord(
    {
      kind: 'inline',
      reference: 'profile:glm-codex',
      label: 'GLM through Codex',
      writable: false,
      trusted: true,
    },
    incompatible,
  )
  const compatibleRecord = createProfileRecord(
    {
      kind: 'inline',
      reference: 'profile:luna-codex',
      label: 'Luna through Codex',
      writable: false,
      trusted: true,
    },
    compatibleModel,
  )
  const app = createBraidApplication({ fixture: 'deterministic', profile: incompatible })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app, {}, undefined, {
    profiles: [incompatibleRecord, compatibleRecord],
  })
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TUI(terminal)
  let operation = 0
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-profile-compatibility-${++operation}`,
  })
  const done = view.start()

  terminal.sendInput('/profile')
  terminal.sendInput('\r')
  await waitUntil(() => terminal.getViewport().join('\n').includes('GLM through Codex'))
  terminal.sendInput('\u0016')
  await waitUntil(() => terminal.getViewport().join('\n').includes('unsupported pair'))
  const screen = terminal.getViewport().join('\n')
  assert.match(screen, /harness=codex · model=zai\/glm-5\.2/u)
  assert.match(screen, /authored profile "GLM through Codex" remains unchanged/u)
  assert.match(screen, /change runner to opencode/u)
  assert.match(screen, /change model to openai\/gpt-5\.6-luna/u)
  assert.match(screen, /runner\/model choice required/u)

  view.stop()
  await done
  await app.close()
})
