import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { connectRemoteSupervisor } from '@tangle-network/agent-runtime/kernel'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { writeCastGif, writeRaster } from './capture-visual-support.mjs'
import { installPackedBraid } from './packed-binary.mjs'

const run = promisify(execFile)
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/** The existing visual proof surface, using an operator-supplied real Runtime read capability. */
export async function captureRemoteSupervision(endpointEnv) {
  assert.match(endpointEnv ?? '', /^[A-Z_][A-Z0-9_]*$/u)
  const endpoint = JSON.parse(process.env[endpointEnv] ?? 'null')
  assert.ok(endpoint?.url && endpoint.headers, 'Supply a protected Runtime readOnly handle')
  const reader = await connectRemoteSupervisor({
    url: endpoint.url,
    protectedHeaders: endpoint.headers,
    timeoutMs: 5_000,
  })
  const tree = await reader.tree()
  await reader.close()
  assert.ok(tree.nodes.length > 0, 'The real remote run must expose agents')
  const repository = new URL('../', import.meta.url).pathname
  const outputRoot = join(
    process.env.BRAID_RELEASE_ARTIFACT_ROOT ?? join(repository, 'artifacts/verification'),
    'remote-supervision',
  )
  await mkdir(outputRoot, { recursive: true })
  const packed = await installPackedBraid(repository)
  const forbidden = [endpoint.url, ...Object.values(endpoint.headers)]
  const safeEvidence = (value) => {
    for (const secret of forbidden)
      assert.ok(!value.includes(secret), 'A protected Runtime capability reached capture evidence')
    return value
  }
  const results = []
  try {
    for (const [columns, rows] of [
      [40, 12],
      [80, 24],
      [120, 40],
      [200, 60],
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'braid-remote-capture-'))
      const workspace = join(root, 'workspace')
      const config = join(root, 'config.json')
      const key = join(root, 'database.key')
      const recordPath = join(outputRoot, `${columns}x${rows}-state.json`)
      await mkdir(workspace)
      await writeFile(key, randomBytes(32), { mode: 0o600 })
      const now = new Date().toISOString()
      await writeFile(
        config,
        JSON.stringify({
          format: 'braid-startup-config',
          schemaVersion: 2,
          profile: {
            name: 'Runtime observer',
            description: 'Read-only observation of an existing remote run; no turn is sent',
            harness: 'pi',
            model: { default: 'openai/gpt-5' },
          },
          connectionId: 'connection-observer-unused',
          databaseKeyFile: key,
          connections: [
            {
              id: 'connection-observer-unused',
              kind: 'cli-bridge',
              name: 'No execution requested',
              endpoint: 'http://127.0.0.1:9',
              providerOptions: { transport: 'local' },
              createdAt: now,
              updatedAt: now,
              lastHealth: { status: 'unknown' },
            },
          ],
        }),
        { mode: 0o600 },
      )
      const emulator = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true })
      const events = []
      let output = ''
      let pending = 0
      const started = performance.now()
      const stamp = () => Number(((performance.now() - started) / 1_000).toFixed(6))
      const child = pty.spawn(
        process.execPath,
        [
          packed.binary,
          '--workspace',
          workspace,
          '--config',
          config,
          '--database-key-file',
          key,
          '--record-state',
          recordPath,
        ],
        {
          cols: columns,
          rows,
          cwd: workspace,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            NODE_NO_WARNINGS: '1',
            BRAID_STATE_PATH: join(root, 'state.sqlite'),
            XDG_DATA_HOME: join(root, 'data'),
            XDG_CONFIG_HOME: join(root, 'config'),
          },
        },
      )
      let exit
      const exited = new Promise((resolve) =>
        child.onExit((value) => {
          exit = value
          resolve(value)
        }),
      )
      child.onData((value) => {
        output += value
        events.push([stamp(), 'o', value])
        pending += 1
        emulator.write(value, () => {
          pending -= 1
        })
      })
      const input = (value) => {
        events.push([stamp(), 'i', value])
        child.write(value)
      }
      const screen = () =>
        Array.from(
          { length: rows },
          (_, index) =>
            emulator.buffer.active
              .getLine(emulator.buffer.active.viewportY + index)
              ?.translateToString(true) ?? '',
        ).join('\n')
      const waitFor = async (predicate, label) => {
        const deadline = Date.now() + 12_000
        while (!predicate()) {
          if (exit || Date.now() > deadline)
            throw new Error(`Remote terminal capture failed at ${label}: ${safeEvidence(screen())}`)
          await sleep(25)
        }
      }
      const cast = (title, entries) =>
        [
          JSON.stringify({
            version: 2,
            width: columns,
            height: rows,
            timestamp: Math.floor(Date.now() / 1_000),
            title,
            command: 'packed braid; existing remote Runtime run; no execution turn',
            env: { TERM: 'xterm-256color' },
          }),
          ...entries.map((value) => JSON.stringify(value)),
          '',
        ].join('\n')
      const capture = async (name) => {
        await waitFor(() => pending === 0, 'terminal frame')
        const prefix = join(outputRoot, `${columns}x${rows}-${name}`)
        await writeFile(`${prefix}.txt`, safeEvidence(screen()))
        await writeFile(
          `${prefix}.cast`,
          safeEvidence(cast(`Real remote Runtime ${name}`, [[0, 'o', output]])),
        )
        await writeRaster(`${prefix}.cast`, `${prefix}.png`, `${prefix}.gif`)
      }
      try {
        await sleep(1_500)
        input(`/graph --remote-env ${endpointEnv}\r`)
        await waitFor(
          () =>
            screen().includes('conversation graph') &&
            tree.nodes.some((node) => screen().includes(node.label)),
          'remote tree',
        )
        await sleep(400)
        await capture('tree')
        // From the selected conversation branch, visit the Runtime group, then two real agents.
        input('\u001b[B')
        await sleep(250)
        input('\u001b[B')
        await sleep(400)
        input('\u001b[B')
        await sleep(700)
        input('\r')
        await sleep(350)
        await capture('agent')
        input('\u001b')
        input('\u001b')
        await sleep(200)
        input('/graph\r')
        await waitFor(() => screen().includes('conversation graph'), 'reopened graph')
        await sleep(250)
        input('\u001b')
        input('\u001b')
        await sleep(100)
        input('/quit\r')
        await Promise.race([
          exited,
          sleep(8_000).then(() => {
            throw new Error('Packed Braid did not quit cleanly')
          }),
        ])
        assert.equal(exit.exitCode, 0)
        const recorded = JSON.parse(safeEvidence(await readFile(recordPath, 'utf8')))
        const actual = recorded.state.workers.map((worker) => worker.runtimeId).sort()
        assert.deepEqual(
          actual,
          tree.nodes.map((node) => node.id).sort(),
          'Every actual Runtime agent must survive in the Braid graph',
        )
        assert.ok(
          recorded.state.workers.some(
            (worker) => worker.streamStatus !== 'select this agent to read its live events',
          ),
          'Agent selection must read the actual Runtime event endpoint',
        )
        assert.ok(
          recorded.state.supervisors.every(
            (supervisor) => supervisor.conversationId === recorded.state.conversationId,
          ),
        )
        const flow = join(outputRoot, `${columns}x${rows}-flow`)
        await writeFile(
          `${flow}.cast`,
          safeEvidence(
            cast(
              'Open real remote topology, select agents, and reopen the persisted graph',
              events,
            ),
          ),
        )
        if (columns === 80) {
          await writeCastGif(`${flow}.cast`, `${flow}.gif`)
          await run('ffmpeg', [
            '-nostdin',
            '-v',
            'error',
            '-y',
            '-i',
            `${flow}.gif`,
            '-vf',
            'pad=ceil(iw/2)*2:ceil(ih/2)*2',
            '-pix_fmt',
            'yuv420p',
            `${flow}.mp4`,
          ])
          await run('ffmpeg', [
            '-nostdin',
            '-v',
            'error',
            '-y',
            '-i',
            `${flow}.mp4`,
            '-vf',
            'fps=1,scale=480:-1,tile=4x4',
            '-frames:v',
            '1',
            `${flow}-review.png`,
          ])
        }
        results.push({
          columns,
          rows,
          agents: actual.length,
          selectionReads: recorded.state.workers.filter(
            (worker) => worker.streamStatus !== 'select this agent to read its live events',
          ).length,
          exit: exit.exitCode,
        })
      } finally {
        if (!exit) child.kill()
        emulator.dispose()
        await rm(root, { recursive: true, force: true })
      }
    }
    await writeFile(
      join(outputRoot, 'manifest.json'),
      JSON.stringify(
        {
          sourceCommit: (
            await run('git', ['rev-parse', 'HEAD'], { cwd: repository })
          ).stdout.trim(),
          tarballSha256: packed.tarballSha256,
          remoteTree: tree,
          results,
          scope:
            'Existing remote run through the published Runtime reader. Unavailable historical live events remain unavailable. No inference, play press, resume, worker spawn or provider turn is requested by Braid.',
        },
        null,
        2,
      ) + '\n',
    )
    console.log(JSON.stringify({ remoteSupervisionCapture: results, outputRoot }))
  } finally {
    await packed.cleanup()
  }
}
