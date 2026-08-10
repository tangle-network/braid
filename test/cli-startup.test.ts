import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { CliUsageError, parseArgs } from '../src/bin/args.js'
import { createStartupPreview } from '../src/startup/preview-runtime.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

async function repositoryRoot(): Promise<URL> {
  const candidates = [new URL('../', import.meta.url), new URL('../../', import.meta.url)]
  for (const candidate of candidates) {
    try {
      await access(new URL('package.json', candidate))
      return candidate
    } catch {}
  }
  throw new Error('Could not locate the Braid repository root')
}

test('expected command-line mistakes remain actionable without echoing arbitrary values', () => {
  assert.throws(
    () => parseArgs(['--workspace'], '/workspace'),
    (error: unknown) =>
      error instanceof CliUsageError && error.message === '--workspace requires a value',
  )
  assert.throws(
    () => parseArgs(['--fixture', 'secret-canary'], '/workspace'),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.message === '--fixture supports only "deterministic"' &&
      !error.message.includes('secret-canary'),
  )
  assert.throws(
    () => parseArgs(['secret-canary'], '/workspace'),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.message === 'Unknown command; expected "rpc" or an option' &&
      !error.message.includes('secret-canary'),
  )
  assert.throws(
    () => parseArgs(['--not-a-real-option'], '/workspace'),
    (error: unknown) =>
      error instanceof CliUsageError && error.message === 'Unknown option: --not-a-real-option',
  )
  assert.throws(
    () => parseArgs(['--ui-fixture', 'product-demo'], '/workspace'),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.message === '--ui-fixture requires --fixture deterministic',
  )
  assert.equal(
    parseArgs(['--fixture', 'deterministic', '--ui-fixture', 'product-demo'], '/workspace')
      .uiFixture,
    'product-demo',
  )
})

test('startup responsibilities stay split into bounded modules', async () => {
  const root = await repositoryRoot()
  const modules = [
    ['src/bin/braid.ts', 50],
    ['src/bin/braid-runtime.ts', 200],
    ['src/bin/interface-signal-lifecycle.ts', 140],
    ['src/bin/interface-runner.ts', 300],
  ] as const

  for (const [path, maximumLines] of modules) {
    const source = await readFile(new URL(path, root), 'utf8')
    assert.ok(
      source.split('\n').length <= maximumLines,
      `${path} should stay at or below ${maximumLines} lines`,
    )
  }

  const launcher = await readFile(new URL('src/bin/braid.ts', root), 'utf8')
  const staticImports = [...launcher.matchAll(/^import .* from ['"]([^'"]+)['"]$/gmu)].map(
    (match) => match[1],
  )
  assert.deepEqual(staticImports, ['node:module', './args.js'])
  const compileCacheIndex = launcher.indexOf('enableCompileCache()')
  const runtimeImportIndex = launcher.indexOf("import('./braid-runtime.js')")
  assert.ok(compileCacheIndex > launcher.indexOf('if (options.version)'))
  assert.ok(runtimeImportIndex > compileCacheIndex)

  const runtime = await readFile(new URL('src/bin/braid-runtime.ts', root), 'utf8')
  const interfaceRunner = await readFile(new URL('src/bin/interface-runner.ts', root), 'utf8')
  const startupBuild = await readFile(new URL('scripts/build-startup.mjs', root), 'utf8')
  assert.match(runtime, /connections: production\.connections/u)
  assert.match(interfaceRunner, /input\.profileConnectionOptions/u)
  assert.match(startupBuild, /minifySyntax: true/u)
  assert.match(startupBuild, /minifyWhitespace: true/u)
  assert.match(startupBuild, /minifyIdentifiers: true/u)
})

test('startup preview renders real route context and replays early input once', async () => {
  const writes: string[] = []
  class RecordingTerminal extends VirtualTerminal {
    override write(data: string): void {
      writes.push(data)
      super.write(data)
    }
  }
  const terminal = new RecordingTerminal(80, 24)
  const preview = createStartupPreview({
    terminal,
    inline: true,
    suppressMetadata: true,
    workspace: '/workspace/braid',
    state: {
      workspace: '/workspace/braid',
      branchId: 'branch-1',
      profile: {
        name: 'Luna coding',
        harness: 'claude-code',
        model: { default: 'moonshot/luna-max' },
      },
      selectedConnectionId: 'connection-local',
      connections: [{ id: 'connection-local', name: 'CLI Bridge' }],
      messages: [
        {
          branchId: 'branch-1',
          role: 'assistant',
          text: 'Ready\u001b[31m safely',
          status: 'complete',
        },
      ],
      runs: [
        {
          branchId: 'branch-1',
          status: 'completed',
          updatedAt: '2026-08-09T00:00:00.000Z',
        },
      ],
    },
  })
  await terminal.waitForRender()
  const output = (await terminal.flushAndGetViewport()).join('\n')
  assert.match(output, /braid · braid/u)
  assert.match(output, /Luna coding · claude-code · moonshot\/luna-max · CLI Bridge · completed/u)
  assert.match(output, /Ready safely/u)
  assert.equal(output.includes('\u001b[31m'), false)
  assert.equal(writes.join('').includes('\u001b]'), false)

  terminal.sendInput('ship ')
  terminal.sendInput('Braid 🚀')
  const first = preview.adopt()
  const second = preview.adopt()
  assert.equal(first, second)
  assert.deepEqual(first.input, ['ship ', 'Braid 🚀'])
  first.tui.stop()
  preview.close()
})

test('startup handoff preserves typed text and shortcuts in the full terminal', async () => {
  const application = createBraidApplication({ fixture: 'deterministic' })
  const controller = createApplicationUiController(application, { color: 'none' })
  const initialized = await controller.initialize('/workspace/braid')
  assert.equal(initialized.kind, 'accepted')
  const terminal = new VirtualTerminal(80, 24)
  const preview = createStartupPreview({
    terminal,
    inline: true,
    suppressMetadata: true,
    workspace: '/workspace/braid',
    state: application.state(),
  })
  const outputPolicyCleanup = preview.outputPolicyCleanup
  assert(outputPolicyCleanup)
  terminal.sendInput('typed before ready')
  terminal.sendInput('\u0010')
  const view = new BraidTerminalApp({
    controller,
    tui: preview.tui,
    theme: createBraidTheme({ colors: false, reducedMotion: true }),
    workspace: '/workspace/braid',
    nextOperationId: () => 'operation-startup-handoff',
    tuiStarted: true,
    preinstalledOutputPolicyCleanup: outputPolicyCleanup,
  })
  const done = view.start(preview.adopt().input)
  try {
    await terminal.waitForRender()
    assert.equal(view.editor.getText(), 'typed before ready')
    assert.equal(preview.tui.hasOverlay(), true)
    assert.match((await terminal.flushAndGetViewport()).join('\n'), /Commands/u)
  } finally {
    view.stop()
    await done
    preview.close()
    await application.close()
  }
})
