import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesKey, setKittyProtocolActive, TuiMainScreen } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { detectColorMode, resolveColorMode } from '../src/views/shared/appearance.js'
import { plainAccessibilityText } from '../src/views/shared/plain-accessibility.js'
import { isTextInputSequence, matchesKeyAction, resolveKeymap } from '../src/views/tui/keyboard.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import {
  installTerminalOutputPolicy,
  keyboardCompatibility,
} from '../src/views/tui/terminal-compatibility.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

test('keyboard bindings accept legacy and Kitty encodings with fallback', () => {
  setKittyProtocolActive(false)
  assert.equal(matchesKey('\u0010', 'ctrl+p'), true)
  assert.equal(matchesKey('\u001b[200~paste\u001b[201~', 'escape'), false)
  setKittyProtocolActive(true)
  assert.equal(matchesKey('\u001b[112;5u', 'ctrl+p'), true)
  setKittyProtocolActive(false)
})

test('appearance honors terminal color capabilities and NO_COLOR', () => {
  assert.equal(detectColorMode({ TERM: 'ansi' }), '16')
  assert.equal(detectColorMode({ TERM: 'xterm-256color' }), '256')
  assert.equal(detectColorMode({ TERM: 'xterm', COLORTERM: 'truecolor' }), 'truecolor')
  assert.equal(resolveColorMode('truecolor', { TERM: 'xterm-256color', NO_COLOR: '1' }), 'none')

  const sixteen = createBraidTheme({ color: 'truecolor', environment: { TERM: 'ansi' } })
  assert.equal(sixteen.color, '16')
  assert.doesNotMatch(sixteen.brand('color'), /38;(?:2|5)/u)

  const noColor = createBraidTheme({ color: 'truecolor', environment: { NO_COLOR: '' } })
  assert.equal(noColor.color, 'none')
  assert.equal(noColor.brand('plain'), 'plain')
})

test('keymap parsing accepts remaps and rejects ambiguous mandatory actions', () => {
  const remapped = resolveKeymap('commandPalette=ctrl+q')
  assert.equal(remapped.valid, true)
  assert.equal(matchesKeyAction('\u0011', remapped.keymap, 'commandPalette'), true)
  assert.equal(matchesKeyAction('\u0010', remapped.keymap, 'commandPalette'), false)

  const conflict = resolveKeymap('commandPalette=ctrl+o')
  assert.equal(conflict.valid, false)
  assert.equal(conflict.diagnostics.join('\n').includes('conversationSelector'), true)
  assert.equal(conflict.diagnostics.join('\n').includes('commandPalette'), true)
  assert.equal(conflict.keymap.commandPalette[0], 'ctrl+p')
})

test('keyboard diagnostics name Kitty limits and preserve the legacy route', () => {
  assert.match(
    keyboardCompatibility({ kittyProtocolActive: false }).message,
    /Kitty protocol unavailable/u,
  )
  assert.match(
    keyboardCompatibility({ kittyProtocolActive: true }).message,
    /Kitty protocol negotiated/u,
  )
  assert.equal(isTextInputSequence('\u001b[200~? 漢字\u001b[201~'), true)
  assert.equal(isTextInputSequence('\u001b[63u'), true)
})

test('plain terminal output strips complete and split OSC metadata but preserves CSI', () => {
  const writes: string[] = []
  const terminal = {
    setProgress: (_active: boolean) => {},
    setTitle: (_title: string) => {},
    write: (data: string) => writes.push(data),
  }
  const restore = installTerminalOutputPolicy(terminal, true)
  terminal.write('\u001b[2J\u001b]0;title')
  terminal.write('\u0007text\u001b]8;;https://example.com\u001b\\\u001b[31m')
  terminal.setTitle('blocked')
  terminal.setProgress(true)
  restore()
  terminal.write('\u001b]0;after\u0007')
  assert.deepEqual(writes, ['\u001b[2J', 'text\u001b[31m', '\u001b]0;after\u0007'])
})

test('plain terminal output discards oversized split OSC data through BEL and ST', () => {
  const writes: string[] = []
  const terminal = {
    setProgress: (_active: boolean) => {},
    setTitle: (_title: string) => {},
    write: (data: string) => writes.push(data),
  }
  const restore = installTerminalOutputPolicy(terminal, true)
  terminal.write('before')
  terminal.write(`\u001b]0;${'x'.repeat(4090)}`)
  terminal.write('BEL tail must not leak')
  terminal.write('\u0007after BEL')
  terminal.write(`\u001b]8;;${'y'.repeat(4090)}`)
  terminal.write('ST tail must not leak')
  terminal.write('\u001b')
  terminal.write('\\after ST')
  restore()
  assert.deepEqual(writes, ['before', 'after BEL', 'after ST'])
})

test('global shortcuts do not steal question marks, Unicode, or Kitty printable input', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'op-input-safety',
  })
  const done = view.start()
  terminal.sendInput('?')
  terminal.sendInput('\u001b[200~漢字 é 👩🏽‍💻\u001b[201~')
  setKittyProtocolActive(true)
  terminal.sendInput('\u001b[63u')
  setKittyProtocolActive(false)
  assert.equal(view.editor.getExpandedText(), '?漢字 é 👩🏽‍💻?')
  view.stop()
  await done
})

test('global command remaps and Kitty key release events execute once', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const remapped = resolveKeymap('commandPalette=ctrl+q')
  assert.equal(remapped.valid, true)
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'op-keymap',
    keymap: remapped.keymap,
  })
  const done = view.start()
  terminal.sendInput('\u0011')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /Commands/u)
  terminal.sendInput('\u001b')
  await terminal.waitForRender()
  setKittyProtocolActive(true)
  terminal.sendInput('\u001b[113;5u')
  terminal.sendInput('\u001b[113;5:3u')
  setKittyProtocolActive(false)
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /Commands/u)
  view.stop()
  await done
})

test('plain accessibility text names the current state and message roles', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  const controller = createApplicationUiController(app)
  await controller.initialize('/workspace')
  const receipt = await controller.dispatch({
    type: 'send',
    operationId: 'op-plain-accessibility',
    text: 'Unicode prompt 漢字',
  })
  assert.equal(receipt.kind, 'accepted')
  if (receipt.kind === 'accepted' && receipt.completion) await receipt.completion
  const text = plainAccessibilityText(controller.view())
  assert.match(text, /status:/u)
  assert.match(text, /user message: Unicode prompt 漢字/u)
  assert.match(text, /assistant message:/u)
  assert.equal(text.includes('\u001b') || text.includes('\u0007'), false)
})
