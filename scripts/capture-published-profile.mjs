// Real installed-profile journey. No play is approved or pressed by this proof.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { writeCastGif } from './capture-visual-support.mjs'
import { castFor, createCapturedTerminal, pause } from './live-demo/terminal.mjs'

const root = resolve(process.env.BRAID_OPERATOR_PROOF_ROOT)
const run = promisify(execFile)
const workspace = join(root, 'workspace')
const output = join(root, 'evidence')
await mkdir(join(workspace, '.braid'), { recursive: true })
await mkdir(output, { recursive: true })
const key = join(root, 'database.key')
try {
  await readFile(key)
} catch {
  await writeFile(key, randomBytes(32), { mode: 0o600 })
}
const now = new Date().toISOString()
await writeFile(
  join(workspace, '.braid/config.json'),
  JSON.stringify({
    format: 'braid-startup-config',
    schemaVersion: 2,
    profile: { name: 'Unselected profile' },
    databaseKeyFile: key,
    connectionId: 'connection-discovery-operator',
    connections: [
      {
        id: 'connection-discovery-operator',
        kind: 'cli-bridge',
        name: 'Discovery operator on GTR',
        endpoint: process.env.BRAID_CLI_BRIDGE_ENDPOINT,
        providerOptions: { transport: 'local' },
        createdAt: now,
        updatedAt: now,
        lastHealth: { status: 'unknown' },
      },
    ],
  }),
  { mode: 0o600 },
)

const binary = process.env.BRAID_OPERATOR_BINARY ?? resolve('dist/bin/braid.js')
const measurements = []
for (const [columns, rows] of [
  [40, 12],
  [80, 24],
  [200, 60],
  [120, 40],
]) {
  const size = `${columns}x${rows}`
  const recordPath = join(root, `state-${size}.json`)
  const terminal = await createCapturedTerminal({
    binary,
    columns,
    rows,
    cwd: workspace,
    recordPath,
    environment: { ...process.env },
    args: [
      '--inline',
      '--profile',
      'discovery-operator',
      '--connection',
      'connection-discovery-operator',
      '--database-key-file',
      key,
      '--record-state',
      recordPath,
    ],
  })
  try {
    await terminal.waitForScreen(
      (screen) => screen.includes('type / for commands'),
      'published profile selected',
      60_000,
    )
    await terminal.waitForStable()
    assert.equal((await terminal.captureState()).view.profileName, 'discovery-operator')
    await writeFile(join(output, `${size}.txt`), terminal.snapshot().screen)
    const frameCast = join(output, `${size}.cast`)
    await writeFile(
      frameCast,
      castFor(terminal, 'Published Discovery Operator', 'braid --profile discovery-operator'),
    )
    const frameGif = join(output, `${size}.tmp.gif`)
    await writeCastGif(frameCast, frameGif)
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      frameGif,
      '-frames:v',
      '1',
      join(output, `${size}.png`),
    ])
    await rm(frameGif)
    if (columns === 120) {
      const cases = [
        ['routing', 'What is 17 times 23? Do not draft a play for this small question.'],
        [
          'observation',
          'How is run jcs-rfc8785-js-20261015b going? Use only disco report, scorecard, receipt and the run page. Do not steer, cancel, resume, preflight, press, merge, or write a retro in this observation turn. Keep unknown accounting unknown.',
        ],
        [
          'intents',
          'Draft two play intents for Drew to review here. This is NOT approval of either play. Never press, queue, resume, fork, or merge a play. First: queens21 team shapes rerun properly, with three runs per shape (solo, tree4, swarm16, peers3), a problem sized to finish in two hours, placement and seat room checked before a future press, and infrastructure failures as missing data. Second: choose one sourced open research intent that exercises observation and steering over a two-to-four-hour Codex run. Save the two intents under intents/ in this workspace, give each an id and a concise review card, and list the check proof and preflight still required before a complete spend card. No installs, builds or tests on GTR or the Mac; use beelink-gate for any such work. Do not start background work.',
        ],
      ]
      for (const [name, prompt] of cases) {
        const before = await terminal.captureState()
        const known = new Set((before.state?.runs ?? []).map((run) => run.id))
        const startedAt = Date.now()
        terminal.input(prompt)
        terminal.input('\r')
        let frame, run
        const deadline = startedAt + 900_000
        while (Date.now() < deadline) {
          await pause(5_000)
          frame = await terminal.captureState(20_000)
          run = frame.state?.runs?.findLast((candidate) => !known.has(candidate.id))
          if (
            run &&
            [
              'completed',
              'failed',
              'unknown',
              'cancelled',
              'aborted',
              'expired',
              'blocked',
            ].includes(run.status)
          )
            break
        }
        assert.ok(run, `${name}: no admitted run`)
        const messages = (frame.state?.messages ?? []).filter((message) => message.runId === run.id)
        const assistant = messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.text)
          .join('\n')
        measurements.push({
          name,
          startedAt: new Date(startedAt).toISOString(),
          observedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          run,
          assistant,
        })
        await writeFile(join(output, 'measurements.json'), JSON.stringify(measurements, null, 2))
        await writeFile(join(output, `${name}-state.json`), JSON.stringify(frame, null, 2))
        assert.equal(run.status, 'completed', `${name}: ${run.error ?? run.status}`)
        if (name === 'routing') assert.match(assistant, /391/u)
      }
    }
    await terminal.closeNormally()
  } finally {
    await writeFile(
      join(output, `${size}-flow-uncut.cast`),
      `${JSON.stringify({ version: 2, width: columns, height: rows, timestamp: Math.floor(Date.now() / 1000), title: 'Uncut operator journey' })}\n${terminal.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    )
    await writeFile(
      join(output, `${size}-flow.cast`),
      castFor(terminal, 'Published operator journey', 'braid --profile discovery-operator'),
    )
    await terminal.dispose()
  }
}
await writeCastGif(join(output, '120x40-flow.cast'), join(output, 'operator-journey.gif'))
console.log(
  JSON.stringify({
    root,
    measurements: measurements.map(({ name, elapsedMs, run }) => ({
      name,
      elapsedMs,
      status: run.status,
    })),
  }),
)
