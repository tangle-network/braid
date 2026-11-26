// Records the `/learn` keyboard flow in the packed Braid binary.
//
// usage: node capture.mjs <repository> <output-directory>
//
// Run after `pnpm build`. Everything the flow reads is invented here: a skills
// checkout, three Claude Code transcripts, a workspace, two checks and a
// learning store, all under one directory in /tmp. The agent is the offline
// `--ui-fixture learning` agent, which tidies only when its profile mounts the
// `tidy` skill, so this records the terminal workflow, not live model quality.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repository, output] = process.argv.slice(2)
if (!repository || !output) throw new Error('usage: node capture.mjs <repository> <output>')
const require = createRequire(join(repository, 'package.json'))
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const { installPackedBraid } = await import(
  pathToFileURL(join(repository, 'scripts/packed-binary.mjs')).href
)
const { captureProvenance } = await import(
  pathToFileURL(join(repository, 'scripts/capture-visual-support.mjs')).href
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const artifacts = []
await mkdir(join(output, 'raw'), { recursive: true })

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  })
}

async function repositoryAt(path, files, remote) {
  await mkdir(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'core.hooksPath', '/dev/null')
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(path, name, '..'), { recursive: true })
    await writeFile(join(path, name), content)
  }
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', 'fixture')
  if (remote) git(path, 'remote', 'add', 'origin', remote)
}

function transcript(sessionId, skills) {
  const lines = []
  let previous = null
  let tick = 0
  const line = (type, uuid, message, extra = {}) => {
    lines.push({
      parentUuid: previous,
      isSidechain: false,
      userType: 'external',
      cwd: '/work/app',
      sessionId,
      version: '0.0.0-fixture',
      type,
      uuid,
      timestamp: new Date(Date.now() - 3_600_000 + 1000 * tick++).toISOString(),
      message,
      ...extra,
    })
    previous = uuid
  }
  line('user', `${sessionId}-u`, { role: 'user', content: 'Invented request.' })
  for (const [index, name] of ['tidy', 'audit'].entries()) {
    const id = `toolu_${sessionId}_${index}`
    line('assistant', `${sessionId}-a${index}`, {
      id: `msg_${sessionId}_${index}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }],
      usage: { input_tokens: 100, output_tokens: 10 },
    })
    line('user', `${sessionId}-r${index}`, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
    })
    const body = name === 'tidy' ? '# Tidy\n\nRemove dead code.' : '# Audit\n\nReview the change.'
    line(
      'user',
      `${sessionId}-l${index}`,
      {
        role: 'user',
        content: [
          { type: 'text', text: `Base directory for this skill: ${join(skills, name)}\n\n${body}` },
        ],
      },
      { isMeta: true, sourceToolUseID: id },
    )
  }
  return `${lines.map((item) => JSON.stringify(item)).join('\n')}\n`
}

async function world() {
  // An explicit /tmp root keeps host and user names out of every recorded path.
  const root = await mkdtemp('/tmp/braid-learn-')
  const skills = join(root, 'skills')
  const projects = join(root, 'claude-projects')
  const workspace = join(root, 'workspace')
  await repositoryAt(
    skills,
    {
      'tidy/SKILL.md': '---\nname: tidy\ndescription: Remove dead code.\n---\n\n# Tidy\n\nRemove dead code.\n',
      'audit/SKILL.md':
        '---\nname: audit\ndescription: Review the change.\n---\n\n# Audit\n\nReview the change.\n',
    },
    'https://github.com/example/skills.git',
  )
  await repositoryAt(workspace, { 'README.md': '# Invented workspace\n' })
  await mkdir(join(projects, '-work-app'), { recursive: true })
  for (const id of ['s1', 's2', 's3'])
    await writeFile(join(projects, '-work-app', `${id}.jsonl`), transcript(id, skills))
  await mkdir(join(root, 'checks'))
  await writeFile(
    join(root, 'checks', 'tidy.mjs'),
    "import { readFileSync } from 'node:fs'\nprocess.exit(readFileSync(process.env.BRAID_REPLAY_ANSWER, 'utf8').startsWith('tidied') ? 0 : 1)\n",
  )
  await writeFile(join(root, 'checks', 'answered.mjs'), 'process.exit(0)\n')
  return { root, projects, workspace, store: join(root, 'learn') }
}

function session(binary, invented, columns, rows, record) {
  const emulator = new Terminal({ cols: columns, rows, allowProposedApi: true })
  const events = []
  const start = performance.now()
  let pending = 0
  let last = start
  let exited = false
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    BRAID_LEARN_DIRECTORY: invented.store,
    BRAID_LEARN_CLAUDE_CODE_PROJECTS: invented.projects,
    BRAID_FIXTURE_CHUNK_DELAY_MS: '4',
  }
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  const args = [binary, '--fixture', 'deterministic', '--ui-fixture', 'learning']
  if (record) args.push('--record-state', record)
  const child = pty.spawn(process.execPath, args, {
    name: 'xterm-256color',
    cols: columns,
    rows,
    cwd: invented.workspace,
    env,
  })
  const exit = new Promise((resolve) =>
    child.onExit((result) => {
      exited = true
      resolve(result)
    }),
  )
  child.onData((data) => {
    events.push([(performance.now() - start) / 1000, 'o', data])
    last = performance.now()
    pending++
    emulator.write(data, () => pending--)
  })
  const screen = () =>
    Array.from(
      { length: rows },
      (_, index) =>
        emulator.buffer.active
          .getLine(emulator.buffer.active.viewportY + index)
          ?.translateToString(true) ?? '',
    ).join('\n')
  const input = (data) => {
    events.push([(performance.now() - start) / 1000, 'i', data])
    child.write(data)
  }
  async function wait(check, label, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    while (!check(screen())) {
      if (Date.now() > deadline) throw new Error(`${columns}x${rows} ${label}\n${screen()}`)
      await sleep(25)
    }
  }
  const settled = () => wait(() => pending === 0 && performance.now() - last > 150, 'settle')
  async function command(text) {
    input(text)
    await sleep(40)
    input('\r')
    await sleep(100)
    await settled()
  }
  async function key(data) {
    input(data)
    await sleep(120)
    await settled()
  }
  const cast = (items) =>
    [
      JSON.stringify({
        version: 2,
        width: columns,
        height: rows,
        timestamp: Math.floor(Date.now() / 1000),
        title: 'Braid learns a profile version',
        command: 'braid --fixture deterministic --ui-fixture learning',
        env: { TERM: 'xterm-256color' },
      }),
      ...items.map((item) => JSON.stringify(item)),
      '',
    ].join('\n')
  async function frame(name) {
    await settled()
    const base = `${columns}x${rows}-${name}`
    const text = join(output, `${base}.txt`)
    await writeFile(text, `${screen()}\n`)
    artifacts.push({ path: `${base}.txt`, sha256: await sha256(text), columns, rows })
  }
  async function close() {
    input('\u0003')
    await sleep(150)
    input('\u0003')
    const result = await Promise.race([
      exit,
      sleep(8000).then(() => {
        throw new Error('Braid did not exit')
      }),
    ])
    assert.equal(result.exitCode, 0)
  }
  const dispose = () => {
    if (!exited) child.kill()
    emulator.dispose()
  }
  return { screen, wait, settled, command, key, frame, close, dispose, cast, events }
}

const packed = await installPackedBraid(repository)
const invented = await world()
try {
  // The whole flow once, recorded as one uncut terminal session.
  const record = join(invented.root, 'state.json')
  const flow = session(packed.binary, invented, 120, 40, record)
  try {
    await flow.wait((text) => text.includes('type / for commands'), 'ready')
    await flow.settled()
    const tidy = ['node', join(invented.root, 'checks', 'tidy.mjs')].join(' ')
    const answered = ['node', join(invented.root, 'checks', 'answered.mjs')].join(' ')
    for (let index = 0; index < 12; index++) {
      const prompt = `Invented task ${index + 1}`
      await flow.command(prompt)
      await flow.wait((text) => text.includes(`untouched: ${prompt}`), `run ${index + 1}`)
      const family = index % 2 === 0 ? 'cleanup' : 'reading'
      await flow.command(`/learn task --family ${family} -- ${index % 2 === 0 ? tidy : answered}`)
      await flow.wait((text) => text.includes('added from run'), `task ${index + 1}`)
      if (index === 0) await flow.frame('task')
      await flow.key('\u001b')
    }
    await flow.command('/learn propose')
    await flow.wait((text) => text.includes('candidates proposed'), 'proposal')
    await flow.frame('proposed')
    await flow.key('\u001b')
    await flow.command('/learn measure')
    await flow.wait((text) => text.includes('passed the gate'), 'measurement', 120_000)
    await flow.frame('measured')
    await flow.key('\r')
    await flow.frame('evidence')
    await flow.key('\u001b')
    await flow.key('\u001b')
    await flow.command('/learn promote')
    await flow.wait((text) => text.includes('Promoted learn.1'), 'promotion')
    await flow.frame('promoted')
    await flow.key('\u001b')
    await flow.command('/learn rollback')
    await flow.wait((text) => text.includes('Rolled back'), 'rollback')
    await flow.frame('rolled-back')
    await flow.key('\u001b')
    await flow.command('/learn promote')
    await flow.wait((text) => text.includes('Promoted learn.2'), 'second promotion')
    await flow.key('\u001b')
    await flow.command('/new')
    await flow.command('/runner codex')
    await flow.key('\u001b')
    await flow.command('Invented follow-up task')
    await flow.wait((text) => text.includes('tidied: Invented follow-up task'), 'served run')
    await flow.command('/learn')
    await flow.wait((text) => text.includes('Served learn.2'), 'served row')
    await flow.frame('served')
    await flow.key('\u001b')
    await flow.close()
    const castPath = join(output, 'raw', 'learn-keyboard.cast')
    await writeFile(castPath, flow.cast(flow.events))
    artifacts.push({ path: 'raw/learn-keyboard.cast', sha256: await sha256(castPath) })
  } finally {
    flow.dispose()
  }

  const state = JSON.parse(await readFile(record, 'utf8')).state
  const served = state.runs.find((run) => run.receipt.requested.text === 'Invented follow-up task')
  assert.equal(served?.receipt.requested.profile.version, 'learn.2')
  assert.equal(served?.receipt.requested.runner, 'codex')
  const versions = (await readFile(join(invented.store, 'versions.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    versions.map((entry) => [entry.action, entry.version]),
    [
      ['promote', 'learn.1'],
      ['rollback', 'unversioned'],
      ['promote', 'learn.2'],
    ],
  )
  const measurement = JSON.parse(await readFile(join(invented.store, 'measurement.json'), 'utf8'))

  // The stored panel at every supported terminal size, from a fresh process.
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 60],
  ]) {
    const panel = session(packed.binary, invented, columns, rows)
    try {
      await panel.wait((text) => text.includes('/ for commands'), 'ready')
      await panel.settled()
      await panel.command('/learn')
      await panel.wait((text) => /Learning/u.test(text), 'panel')
      await panel.frame('panel')
      const castPath = join(output, 'raw', `${columns}x${rows}-panel.cast`)
      await writeFile(castPath, panel.cast(panel.events))
      artifacts.push({ path: `raw/${columns}x${rows}-panel.cast`, sha256: await sha256(castPath) })
      await panel.key('\u001b')
      await panel.close()
    } finally {
      panel.dispose()
    }
    process.stdout.write(`Captured ${columns}x${rows}\n`)
  }

  await writeFile(
    join(output, 'manifest.json'),
    `${JSON.stringify(
      {
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repository,
          encoding: 'utf8',
        }).trim(),
        generatedAt: new Date().toISOString(),
        command: 'node artifacts/verification/learn/raw/capture.mjs <repository> <output>',
        binary: 'clean npm install from the locally packed tarball',
        tarball: packed.tarballName,
        tarballSha256: packed.tarballSha256,
        provenance: await captureProvenance(),
        fixture:
          'offline --ui-fixture learning agent and invented sessions; no live provider integration claim',
        measurement: {
          tasks: measurement.tasks,
          families: measurement.families,
          selected: measurement.selected,
          results: measurement.results.map((result) => ({
            kind: result.kind,
            name: result.name,
            decision: result.decision,
            wins: result.wins,
            losses: result.losses,
            ties: result.ties,
            candidatePassed: `${result.candidate.passed}/${result.candidate.known}`,
            activePassed: `${result.base.passed}/${result.base.known}`,
            loadedTokens: { candidate: result.candidate.loadedTokens, active: result.base.loadedTokens },
            promotable: result.gate.promotable,
            gate: result.gate.reason,
          })),
        },
        served: {
          version: served.receipt.requested.profile.version,
          runner: served.receipt.requested.runner,
        },
        versions: versions.map((entry) => ({ action: entry.action, version: entry.version })),
        artifacts,
      },
      null,
      2,
    )}\n`,
  )
} finally {
  await packed.cleanup()
  await rm(invented.root, { recursive: true, force: true })
}
