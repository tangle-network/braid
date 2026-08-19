import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { assertAccessibleTerminalOutput } from './accessibility-output.mjs'
import { installPackedBraid } from './packed-binary.mjs'

const repository = new URL('../', import.meta.url).pathname
const packed = await installPackedBraid(repository)
const binary = packed.binary
const XtermTerminal = xterm.Terminal

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate, label, diagnostic) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      const detail = diagnostic?.()
      throw new Error(`Timed out waiting for ${label}${detail ? `\n${detail}` : ''}`)
    }
    await sleep(20)
  }
}

function screenFrom(emulator, rows) {
  const buffer = emulator.buffer.active
  return Array.from(
    { length: rows },
    (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '',
  ).join('\n')
}

function normalizeScreen(screen) {
  return screen.replace(/\s+/gu, ' ').trim()
}

async function run(columns, rows, options = {}) {
  const {
    term = 'xterm-256color',
    noColor = true,
    noColorEnvironment = true,
    keymap,
    kitty = false,
    helpDiagnostic = false,
    expectNoExtendedColor = false,
    expectNoMetadata = false,
    bracketedPaste = false,
    prompt = 'pty proof',
  } = options
  const journalPath = join(tmpdir(), `braid-pty-${randomUUID()}.jsonl`)
  const environment = {
    ...process.env,
    TERM: term,
    BRAID_JOURNAL_PATH: journalPath,
  }
  delete environment.FORCE_COLOR
  if (noColorEnvironment) environment.NO_COLOR = '1'
  else delete environment.NO_COLOR
  if (keymap === undefined) delete environment.BRAID_KEYMAP
  else environment.BRAID_KEYMAP = keymap
  const args = [binary, '--fixture', 'deterministic']
  if (noColor) args.push('--no-color')
  const emulator = new XtermTerminal({
    cols: columns,
    rows,
    disableStdin: true,
    allowProposedApi: true,
  })
  try {
    const session = pty.spawn(process.execPath, args, {
      name: term,
      cols: columns,
      rows,
      cwd: repository,
      env: environment,
    })
    let output = ''
    let query = ''
    let screen = ''
    const exited = new Promise((resolve) => session.onExit(resolve))
    session.onData((chunk) => {
      output += chunk
      emulator.write(chunk, () => {
        screen = screenFrom(emulator, rows)
      })
      if (!kitty) return
      query = `${query}${chunk}`.slice(-64)
      if (query.includes('\u001b[>7u')) {
        session.write('\u001b[?7u')
        query = ''
      }
    })
    await waitFor(
      () => normalizeScreen(screen).includes('Braid starter'),
      `${columns}x${rows} conversation shell`,
    )
    if (kitty) session.write('\u001b[112;5u')
    else if (keymap === undefined) session.write('\u0010')
    else session.write('\u0011')
    await waitFor(
      () => normalizeScreen(screen).includes('Commands'),
      `${columns}x${rows} command overlay`,
    )
    if (kitty) session.write('\u001b[112;5:3u')
    session.write('\u001b')
    await waitFor(
      () => !normalizeScreen(screen).includes('Commands'),
      `${columns}x${rows} command overlay close`,
      () => screen,
    )
    if (helpDiagnostic) {
      session.write('/help\r')
      await waitFor(
        () => normalizeScreen(screen).includes('Kitty protocol unavailable'),
        `${columns}x${rows} keyboard fallback diagnostic`,
      )
      session.write('\u001b')
      await waitFor(
        () => !normalizeScreen(screen).includes('Kitty protocol unavailable'),
        `${columns}x${rows} help close`,
        () => screen,
      )
    }
    if (bracketedPaste) session.write(`\u001b[200~${prompt}\u001b[201~`)
    else session.write(prompt)
    session.write('\r')
    const expectedResult = normalizeScreen(`Fixture response through pi: ${prompt}`)
    await waitFor(
      () => normalizeScreen(screen).includes(expectedResult),
      `${columns}x${rows} result`,
      () => screen,
    )
    session.write('\u0003')
    await waitFor(
      () => normalizeScreen(screen).toLowerCase().includes('ctrl+c again to quit'),
      `${columns}x${rows} safe exit`,
    )
    session.write('\u0003')
    const exit = await Promise.race([
      exited,
      sleep(5_000).then(() => {
        session.kill()
        throw new Error('PTY process did not exit')
      }),
    ])
    if (exit.exitCode !== 0) throw new Error(`PTY exited ${exit.exitCode}`)
    if (!output.includes('\u001b[?1049l'))
      throw new Error('alternate-screen cleanup sequence missing')
    if (
      expectNoExtendedColor &&
      (output.includes('\u001b[38;2;') ||
        output.includes('\u001b[38;5;') ||
        output.includes('\u001b[48;2;') ||
        output.includes('\u001b[48;5;'))
    )
      throw new Error(`${term} PTY emitted extended-color SGR despite the terminal limit`)
    if (expectNoMetadata) assertAccessibleTerminalOutput(output)
    return output
  } finally {
    emulator.dispose()
    await rm(journalPath, { force: true })
  }
}

async function runAutocompleteRace() {
  const columns = 120
  const rows = 36
  const journalPath = join(tmpdir(), `braid-pty-autocomplete-${randomUUID()}.jsonl`)
  const emulator = new XtermTerminal({
    cols: columns,
    rows,
    disableStdin: true,
    allowProposedApi: true,
  })
  const environment = {
    ...process.env,
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    BRAID_JOURNAL_PATH: journalPath,
  }
  delete environment.FORCE_COLOR
  const session = pty.spawn(
    process.execPath,
    [binary, '--fixture', 'deterministic', '--no-color'],
    {
      name: 'xterm-256color',
      cols: columns,
      rows,
      cwd: repository,
      env: environment,
    },
  )
  let output = ''
  let screen = ''
  const exited = new Promise((resolve) => session.onExit(resolve))
  session.onData((chunk) => {
    output += chunk
    emulator.write(chunk, () => {
      screen = screenFrom(emulator, rows)
    })
  })
  try {
    await waitFor(
      () => normalizeScreen(screen).includes('Braid starter'),
      'autocomplete race conversation shell',
    )
    session.write('/')
    await waitFor(
      () => normalizeScreen(screen).includes('Create an empty conversation'),
      'autocomplete race stale menu',
    )

    // One PTY write is intentionally split into printable keys plus Enter by Pi's
    // StdinBuffer. Enter must not accept the menu created for the older "/" draft.
    session.write('profile\r')
    await waitFor(
      () =>
        normalizeScreen(screen).includes('profile') &&
        normalizeScreen(screen).includes('Braid starter') &&
        normalizeScreen(screen).includes('runner pi · model fixture/deterministic') &&
        normalizeScreen(screen).includes('←/esc close'),
      'exact /profile overlay',
    )
    if (/unknown command \/profil(?:new|enew)/iu.test(output))
      throw new Error('stale slash completion changed /profile before submit')

    session.write('\u001b')
    await waitFor(
      () => !normalizeScreen(screen).includes('runner pi · model fixture/deterministic'),
      'autocomplete race profile close',
      () => screen,
    )
    session.write('\u0003')
    await waitFor(
      () => normalizeScreen(screen).toLowerCase().includes('ctrl+c again to quit'),
      'autocomplete race safe exit',
      () => screen,
    )
    session.write('\u0003')
    const exit = await Promise.race([
      exited,
      sleep(5_000).then(() => {
        session.kill()
        throw new Error('Autocomplete race PTY process did not exit')
      }),
    ])
    if (exit.exitCode !== 0) throw new Error(`Autocomplete race PTY exited ${exit.exitCode}`)
    if (!output.includes('\u001b[?1049l'))
      throw new Error('autocomplete race alternate-screen cleanup sequence missing')
  } finally {
    emulator.dispose()
    session.kill()
    await rm(journalPath, { force: true })
  }
}

try {
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 60],
  ])
    await run(columns, rows, { expectNoMetadata: true })
  await run(80, 24, {
    noColor: false,
    noColorEnvironment: true,
    expectNoExtendedColor: true,
  })
  await run(80, 24, {
    noColor: false,
    noColorEnvironment: false,
    term: 'ansi',
    expectNoExtendedColor: true,
  })
  await run(80, 24, {
    noColor: false,
    noColorEnvironment: false,
    keymap: 'commandPalette=ctrl+q',
  })
  await run(80, 24, {
    noColor: false,
    noColorEnvironment: false,
    helpDiagnostic: true,
  })
  await run(80, 24, {
    noColor: false,
    noColorEnvironment: false,
    kitty: true,
  })
  await run(80, 24, {
    bracketedPaste: true,
    prompt: 'pty proof 漢字 é 👩🏽‍💻',
  })
  await runAutocompleteRace()
  process.stdout.write('Packed PTY proof passed at 40x12, 80x24, 120x40, and 200x60\n')
} finally {
  await packed.cleanup()
}
