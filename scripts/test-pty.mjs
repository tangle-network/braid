import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installPackedBraid } from './packed-binary.mjs'

const repository = new URL('../', import.meta.url).pathname
const packed = await installPackedBraid(repository)
const binary = packed.binary

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(20)
  }
}

async function run(columns, rows) {
  const environment = {
    ...process.env,
    NO_COLOR: '1',
    TERM: 'xterm-256color',
    BRAID_JOURNAL_PATH: join(tmpdir(), `braid-pty-${randomUUID()}.jsonl`),
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
  const exited = new Promise((resolve) => session.onExit(resolve))
  session.onData((chunk) => {
    output += chunk
  })
  await waitFor(() => output.includes('braid'), `${columns}x${rows} header`)
  session.write('\u0010')
  await waitFor(() => output.includes('Commands'), `${columns}x${rows} command overlay`)
  session.write('\u001b')
  await sleep(100)
  session.write('pty proof')
  session.write('\r')
  await waitFor(
    () => output.includes('Fixture response through pi: pty proof'),
    `${columns}x${rows} result`,
  )
  session.write('\u0003')
  await waitFor(
    () => output.includes('press ctrl+c again to quit') || output.includes('ctrl+c again to quit'),
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
  return output
}

try {
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 60],
  ])
    await run(columns, rows)
  process.stdout.write('Packed PTY proof passed at 40x12, 80x24, 120x40, and 200x60\n')
} finally {
  await packed.cleanup()
}
