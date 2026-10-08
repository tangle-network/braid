import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { visibleWidth } from '@earendil-works/pi-tui'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import {
  captureProvenance,
  createArtifactFor,
  writeCastGif,
  writeRaster,
} from './capture-visual-support.mjs'
import { installPackedBraid } from './packed-binary.mjs'
import { gitValue, sourceDigest } from './package-proof-runtime.mjs'

const repository = new URL('../', import.meta.url).pathname
const outputRoot = resolve(
  process.env.BRAID_NATIVE_CHILD_CAPTURE_ROOT ??
    join(repository, 'artifacts/verification/native-children'),
)
const sizes = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
]
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const digest = (value) => createHash('sha256').update(value).digest('hex')
const sha256 = async (path) => digest(await readFile(path))
const artifactFor = createArtifactFor(outputRoot, sha256)

async function waitFor(predicate, label, diagnostic = () => '', timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}\n${diagnostic()}`)
    await sleep(20)
  }
}

function castFor(columns, rows, events, title) {
  const settled = [...events, [(events.at(-1)?.[0] ?? 0) + 0.1, 'o', '\u001b[0m']]
  return [
    JSON.stringify({
      version: 2,
      width: columns,
      height: rows,
      timestamp: Math.floor(Date.now() / 1000),
      duration: settled.at(-1)[0],
      idle_time_limit: 1,
      command: 'braid --fixture deterministic --ui-fixture native-children',
      title,
      env: { TERM: 'xterm-256color' },
      stdin: true,
    }),
    ...settled.map((event) => JSON.stringify(event)),
    '',
  ].join('\n')
}

async function openTerminal(binary, columns, rows, root) {
  const recordPath = join(root, 'state.json')
  const emulator = new xterm.Terminal({
    cols: columns,
    rows,
    allowProposedApi: true,
    disableStdin: true,
  })
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    NODE_NO_WARNINGS: '1',
  }
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  const session = pty.spawn(
    process.execPath,
    [
      binary,
      '--fixture',
      'deterministic',
      '--ui-fixture',
      'native-children',
      '--workspace',
      '/workspace',
      '--record-state',
      recordPath,
    ],
    {
      name: 'xterm-256color',
      cols: columns,
      rows,
      cwd: root,
      env,
    },
  )
  const events = []
  const started = performance.now()
  let screen = ''
  let pending = 0
  let lastOutput = performance.now()
  let exited = false
  const exit = new Promise((done) =>
    session.onExit((value) => {
      exited = true
      done(value)
    }),
  )
  const record = (kind, value) =>
    events.push([Number(((performance.now() - started) / 1000).toFixed(6)), kind, value])
  session.onData((data) => {
    record('o', data)
    pending += 1
    lastOutput = performance.now()
    emulator.write(data, () => {
      const buffer = emulator.buffer.active
      screen = Array.from(
        { length: rows },
        (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '',
      ).join('\n')
      pending -= 1
    })
  })
  const stable = () =>
    waitFor(
      () => pending === 0 && performance.now() - lastOutput > 100,
      'settled frame',
      () => screen,
    )
  const input = async (value) => {
    record('i', value)
    session.write(value)
    await sleep(value === '\u001b' ? 300 : 30)
    await stable()
  }
  return {
    events,
    screen: () => screen,
    stable,
    input,
    waitForScreen: (predicate, label) =>
      waitFor(
        () => predicate(screen.replace(/\s+/gu, ' ')),
        label,
        () => screen,
      ),
    snapshot: async () => {
      process.kill(session.pid, 'SIGUSR2')
      const path = `${recordPath}.frame`
      await waitFor(
        async () => (await readFile(path, 'utf8').catch(() => '')).includes('atomic-signal-frame'),
        'semantic snapshot',
      )
      return JSON.parse(await readFile(path, 'utf8'))
    },
    close: async () => {
      await input('\u001b')
      await input('\u001b')
      await input('\u0003')
      await waitFor(
        () => screen.toLowerCase().includes('ctrl+c again to quit'),
        'safe quit',
        () => screen,
      )
      await input('\u0003')
      const result = await Promise.race([
        exit,
        sleep(5000).then(() => {
          throw new Error('Packed capture did not exit')
        }),
      ])
      assert.equal(result.exitCode, 0)
    },
    dispose: () => {
      if (!exited) session.kill()
      emulator.dispose()
    },
  }
}

async function saveFrame(terminal, columns, rows, state, artifacts) {
  const name = `${columns}x${rows}-${state}`
  const frame = terminal.screen()
  assert(
    frame.split('\n').every((line) => visibleWidth(line) <= columns),
    `${name} exceeds viewport width`,
  )
  const textPath = join(outputRoot, `${name}.txt`)
  const castPath = join(outputRoot, 'raw', `${name}.cast`)
  const pngPath = join(outputRoot, `${name}.png`)
  await writeFile(textPath, `${frame}\n`)
  await writeFile(castPath, castFor(columns, rows, terminal.events, name))
  await writeRaster(castPath, pngPath, join(outputRoot, 'raw', `${name}.gif`))
  for (const [path, kind] of [
    [textPath, 'terminal-frame'],
    [castPath, 'asciicast'],
    [pngPath, 'png'],
  ]) {
    artifacts.push(await artifactFor(path, kind, columns, rows, state))
  }
}

async function capture(binary, columns, rows, artifacts) {
  const root = await mkdtemp(join(tmpdir(), 'braid-native-child-capture-'))
  const terminal = await openTerminal(binary, columns, rows, root)
  try {
    await terminal.waitForScreen((text) => text.includes('Braid starter'), 'conversation shell')
    await terminal.input('Inspect native children\r')
    await terminal.waitForScreen(
      (text) => text.includes('two native children reported'),
      'fixture completion',
    )
    await terminal.input('/activity\r')
    await terminal.waitForScreen((text) => text.includes('activity'), 'activity browser')
    await terminal.input('\t')
    await terminal.input('\t')
    await terminal.input('\t')
    await terminal.waitForScreen(
      (text) => text.includes('Check tests') && text.includes('Review patch'),
      'native child rows',
    )
    await saveFrame(terminal, columns, rows, 'activity', artifacts)
    await terminal.input('\u001b[H')
    await terminal.input('\r')
    await saveFrame(terminal, columns, rows, 'parent-detail', artifacts)
    let parentInspected = terminal.screen()
    for (
      let page = 0;
      page < 16 && !parentInspected.includes('observed tokens: 24 in / 8 out');
      page += 1
    ) {
      await terminal.input('\u001b[6~')
      parentInspected += `\n${terminal.screen()}`
    }
    assert.match(parentInspected, /observed tokens: 24 in \/ 8 out/u)
    await saveFrame(terminal, columns, rows, 'parent-usage', artifacts)
    await terminal.input('\u001b[B')
    await terminal.input('\r')
    await terminal.waitForScreen((text) => text.includes('Check tests'), 'nested child detail')
    await saveFrame(terminal, columns, rows, 'nested-detail', artifacts)
    const snapshot = await terminal.snapshot()
    const children = snapshot.view.activity.filter((item) => item.kind === 'native-child')
    assert.equal(children.length, 2, 'Semantic view did not retain both native children')
    const checker = children.find((child) => child.title === 'Check tests')
    const reviewer = children.find((child) => child.title === 'Review patch')
    assert(checker && reviewer, 'Missing child identities')
    assert.equal(checker.parentId, reviewer.id)
    assert(children.every((child) => child.status === 'complete'))
    assert.equal(snapshot.view.activity.filter((item) => item.kind === 'worker').length, 0)
    assert.equal(snapshot.state.runs[0]?.inputTokens, 10, 'Child usage changed run totals')
    assert.equal(snapshot.state.runs[0]?.outputTokens, 6, 'Child usage changed run totals')
    const semanticPath = join(outputRoot, `${columns}x${rows}-semantic.json`)
    await writeFile(semanticPath, `${JSON.stringify(snapshot, null, 2)}\n`)
    artifacts.push(
      await artifactFor(semanticPath, 'semantic-state', columns, rows, 'nested-detail'),
    )
    let inspected = terminal.screen()
    for (let page = 0; page < 16 && !inspected.includes('parent child: native-review'); page += 1) {
      await terminal.input('\u001b[6~')
      inspected += `\n${terminal.screen()}`
    }
    assert.match(inspected, /child: native-check/u)
    assert.match(inspected, /parent child: native-review/u)
    await saveFrame(terminal, columns, rows, 'nested-parent', artifacts)
    await terminal.input('x')
    await terminal.waitForScreen(
      (text) => text.includes('native child controls unavailable'),
      'native controls refusal',
    )
    await terminal.input('\u001b')
    if (columns === 80) {
      const castPath = join(outputRoot, 'native-children-keyboard.cast')
      const gifPath = join(outputRoot, '80x24-native-children-keyboard.gif')
      await writeFile(
        castPath,
        castFor(
          columns,
          rows,
          terminal.events,
          'Native child keyboard inspection and control refusal',
        ),
      )
      await writeCastGif(castPath, gifPath)
      artifacts.push(await artifactFor(castPath, 'keyboard-asciicast', columns, rows))
      artifacts.push(await artifactFor(gifPath, 'keyboard-recording', columns, rows))
    }
    await terminal.close()
  } finally {
    terminal.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

const sourceSha256 = await sourceDigest(repository)
const packed = await installPackedBraid(repository)
try {
  await mkdir(join(outputRoot, 'raw'), { recursive: true })
  const artifacts = []
  for (const [columns, rows] of sizes) await capture(packed.binary, columns, rows, artifacts)
  assert.equal(await sourceDigest(repository), sourceSha256, 'Source changed during capture')
  await writeFile(
    join(outputRoot, 'capture-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        command: 'node scripts/capture-native-children.mjs',
        execution:
          'Real packed Braid binary in node-pty with deterministic ExecutionPort events. No live native runner or cloud integration claim.',
        source: { commit: gitValue('rev-parse', 'HEAD'), digest: sourceSha256 },
        package: {
          tarball: packed.tarballName,
          sha256: packed.tarballSha256,
          binarySha256: await sha256(packed.binary),
        },
        provenance: await captureProvenance(),
        keyboard: [
          'submit fixture turn',
          '/activity',
          'Tab to workers',
          'Enter parent and inspect usage',
          'Down to nested child',
          'PageDown through parent identity',
          'x refuses Runtime worker controls',
          'Escape',
          'Ctrl+C twice',
        ],
        assertions: [
          'two native children',
          'parent identity retained',
          'completed lifecycle retained after duplicate',
          'zero Runtime worker activities',
          'child usage does not change run totals',
          'bounded frame widths',
          'read-only controls',
        ],
        artifacts,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`Captured native children at four sizes in ${relative(repository, outputRoot)}`)
} finally {
  await packed.cleanup()
}
