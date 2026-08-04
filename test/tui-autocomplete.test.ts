import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  CombinedAutocompleteProvider,
  Editor,
  StdinBuffer,
  TUI,
} from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { GuardedAutocompleteProvider } from '../src/views/tui/autocomplete-guard.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for autocomplete state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function fakeProvider(item: AutocompleteItem): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol) {
      return {
        prefix: lines[cursorLine]?.slice(0, cursorCol) ?? '',
        items: [item],
      }
    },
    applyCompletion(lines, cursorLine, cursorCol, selected, prefix) {
      const line = lines[cursorLine] ?? ''
      const start = Math.max(0, cursorCol - prefix.length)
      const next = [...lines]
      next[cursorLine] = `${line.slice(0, start)}${selected.value}${line.slice(cursorCol)}`
      return { lines: next, cursorLine, cursorCol: start + selected.value.length }
    },
  }
}

function createEditor(delegate: AutocompleteProvider): {
  readonly editor: Editor
  readonly provider: GuardedAutocompleteProvider
  readonly stop: () => void
} {
  const terminal = new VirtualTerminal(100, 30)
  const tui = new TUI(terminal)
  const provider = new GuardedAutocompleteProvider(delegate)
  const editor = new Editor(tui, createBraidTheme(false).editor, { paddingX: 1 })
  editor.onChange = () => provider.inputChanged()
  editor.setAutocompleteProvider(provider)
  tui.addChild(editor)
  tui.setFocus(editor)
  tui.start()
  return { editor, provider, stop: () => tui.stop() }
}

test('human typing cannot apply a stale slash completion on Enter', async () => {
  const { editor, stop } = createEditor(fakeProvider({ value: 'new', label: 'new' }))
  let submitted = ''
  editor.onSubmit = (text) => {
    submitted = text
  }
  try {
    editor.handleInput('/')
    await settle()
    assert.equal(editor.isShowingAutocomplete(), true)

    for (const character of 'profile') editor.handleInput(character)
    editor.handleInput('\r')

    assert.equal(submitted, '/profile')
    assert.equal(editor.getText(), '')
  } finally {
    stop()
  }
})

test('paste bypasses slash completion and submits the exact pasted draft', () => {
  const { editor, stop } = createEditor(fakeProvider({ value: 'new', label: 'new' }))
  let submitted = ''
  editor.onSubmit = (text) => {
    submitted = text
  }
  try {
    editor.handleInput('\u001b[200~/profile\u001b[201~')
    editor.handleInput('\r')
    assert.equal(submitted, '/profile')
  } finally {
    stop()
  }
})

test('same-chunk text followed by Enter submits the exact slash command', async () => {
  const { editor, stop } = createEditor(fakeProvider({ value: 'new', label: 'new' }))
  const input = new StdinBuffer()
  let submitted = ''
  editor.onSubmit = (text) => {
    submitted = text
  }
  input.on('data', (sequence: string) => editor.handleInput(sequence))
  try {
    editor.handleInput('/')
    await settle()
    input.process('profile\r')
    assert.equal(submitted, '/profile')
  } finally {
    input.destroy()
    stop()
  }
})

test('Tab cannot apply a completion left over from an older draft', async () => {
  const { editor, stop } = createEditor(fakeProvider({ value: 'new', label: 'new' }))
  try {
    editor.handleInput('/')
    await settle()
    editor.handleInput('profile')
    editor.handleInput('\t')
    assert.equal(editor.getText(), '/profile')
  } finally {
    stop()
  }
})

test('moving the cursor prevents a completion for its former position', async () => {
  const { editor, stop } = createEditor(fakeProvider({ value: 'new', label: 'new' }))
  try {
    editor.handleInput('/')
    await settle()
    editor.handleInput('\u001b[D')
    editor.handleInput('\t')
    assert.equal(editor.getText(), '/')
  } finally {
    stop()
  }
})

test('an async completion for the old draft is discarded', async () => {
  let releaseOld: () => void = () => {}
  let markStarted: () => void = () => {}
  const oldResultStarted = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const oldResult = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  const delegate: AutocompleteProvider = {
    async getSuggestions(lines, cursorLine, cursorCol) {
      const prefix = lines[cursorLine]?.slice(0, cursorCol) ?? ''
      if (prefix === '/') {
        markStarted()
        await oldResult
        return { prefix, items: [{ value: 'new', label: 'new' }] }
      }
      return null
    },
    applyCompletion: fakeProvider({ value: 'new', label: 'new' }).applyCompletion,
  }
  const { editor, stop } = createEditor(delegate)
  let submitted = ''
  editor.onSubmit = (text) => {
    submitted = text
  }
  try {
    editor.handleInput('/')
    await oldResultStarted
    editor.handleInput('profile')
    releaseOld()
    await settle()
    assert.equal(editor.isShowingAutocomplete(), false)
    editor.handleInput('\r')
    assert.equal(submitted, '/profile')
  } finally {
    stop()
  }
})

test('an exact slash command remains exact while Enter accepts a current suggestion', async () => {
  const delegate = new CombinedAutocompleteProvider(
    [{ name: 'profile', description: 'select a profile' }],
    '/workspace',
    null,
  )
  const { editor, stop } = createEditor(delegate)
  let submitted = ''
  editor.onSubmit = (text) => {
    submitted = text
  }
  try {
    editor.handleInput('/')
    for (const character of 'profile') editor.handleInput(character)
    await settle()
    editor.handleInput('\r')
    assert.equal(submitted, '/profile')
  } finally {
    stop()
  }
})

test('Tab selects a completion only for the current editor state', async () => {
  const delegate = new CombinedAutocompleteProvider(
    [{ name: 'profile', description: 'select a profile' }],
    '/workspace',
    null,
  )
  const { editor, stop } = createEditor(delegate)
  try {
    editor.handleInput('/')
    for (const character of 'pro') editor.handleInput(character)
    await settle()
    editor.handleInput('\t')
    assert.equal(editor.getText(), '/profile ')
  } finally {
    stop()
  }
})

test('the production terminal does not turn a fast profile command into unknown text', async () => {
  const terminal = new VirtualTerminal(120, 36)
  const tui = new TUI(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'op-autocomplete-profile',
  })
  const done = view.start()
  try {
    terminal.sendInput('/')
    await waitUntil(() => view.editor.isShowingAutocomplete())
    terminal.sendInput('profile')
    terminal.sendInput('\r')
    await waitUntil(() => terminal.getViewport().join('\n').includes('profiles'))
    const screen = terminal.getViewport().join('\n')
    assert.doesNotMatch(screen, /unknown command \/profilnew/iu)
    assert.doesNotMatch(screen, /unknown command \/profilenew/iu)
  } finally {
    view.stop()
    await done
  }
})
