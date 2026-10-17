#!/usr/bin/env node
// One-command Braid live release, run from the operator machine:
//
//   node scripts/release/live-release.mjs --pr <n> [--runs 3] [--host beelink1] [--gh gh-drew] [--dry-run]
//   node scripts/release/live-release.mjs --commit <main-sha> [--host beelink1] [--gh gh-drew] [--dry-run]
//
// With --pr: full code gate at the PR head on the pinned Beelink, then --runs consecutive LIVE-07 runs, each
// started only once the shared Sandbox account has settled; results go to the PR as comments. At N/N with an
// unchanged head and no unread human review, the PR is merged with --match-head-commit. Then, for the merge
// commit (or --commit): Release candidate (publish=false), Release Live Evidence (retried once), Release
// publish=true. --dry-run prints the plan and the read-only preflight (credential files, account state) only.
//
// Two subcommands run on the Beelink and are started by the driver, not by hand:
//   observe          one account observation (stdin module over ssh); exit 0 when settled
//   live-run <n>     one live-tangle run in a beelink-gate checkout; exit 0 only when the LIVE-07 row passed
// Credential values are read from owner-only files in --key-dir on the Beelink and never printed.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = 'tangle-network/braid'
const REPO_URL = `git@github.com:${REPO}.git`
const CODE_GATE = [
  'set -e',
  'pnpm run format:check',
  'pnpm run lint',
  'pnpm run typecheck',
  'pnpm run boundaries',
  'for f in scripts/live-required/*.mjs; do F="$PWD/$f" node --input-type=module -e "await import(process.env.F)" >/dev/null; done',
  'echo live-required-imports-OK',
  'pnpm test',
  'pnpm run test:property',
].join('; ')
// The protected live configuration the 0.3.4 release used; the environment overrides each value.
const LIVE_CONFIG = {
  BRAID_TANGLE_ENDPOINT: 'https://router.tangle.tools/v1',
  BRAID_TANGLE_MODEL: 'glm-5.3',
  BRAID_TANGLE_SANDBOX_ENDPOINT: 'https://sandbox.tangle.tools',
  BRAID_TANGLE_SANDBOX_MODEL: 'tangle-router/glm-5.3',
  BRAID_TANGLE_SANDBOX_RUNNER: 'opencode',
}
const KEY_FILES = { router: 'router.key', sandbox: 'sandbox.key' }
const MINUTE = 60_000
const SETTLED_AGE_MINUTES = 10
const REPORT_LINE =
  /^(live-run |live-tangle rc=|ROW |RESULT |SOAK |WAIT |EVIDENCE |ATTEMPT |PERMISSION |LIVE-07 |build failed)|beelink-gate receipt|beelink-gate: .*(TEMPFAIL|unavailable|hold limit)/

const redact = (text) => String(text).replace(/(sk|tan|tg)[-_][A-Za-z0-9_-]{12,}/g, '<redacted>')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const home = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function parseArgs(argv) {
  const o = {
    runs: 3,
    host: 'beelink1',
    gh: 'gh',
    keyDir: '~/.braid-live',
    hours: 10,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => argv[++i] ?? fail(`${flag} needs a value`)
    if (flag === '--pr') o.pr = Number(value())
    else if (flag === '--commit') o.commit = value()
    else if (flag === '--runs') o.runs = Number(value())
    else if (flag === '--host') o.host = value()
    else if (flag === '--ssh') o.ssh = value()
    else if (flag === '--gh') o.gh = value()
    else if (flag === '--key-dir') o.keyDir = value()
    else if (flag === '--hours') o.hours = Number(value())
    else if (flag === '--dry-run') o.dryRun = true
    else fail(`unknown option ${flag}`)
  }
  if (o.pr !== undefined && o.commit !== undefined) fail('pass --pr or --commit, not both')
  if (o.commit !== undefined && !/^[0-9a-f]{40}$/.test(o.commit)) fail('--commit needs a full SHA')
  o.ssh ??= `${o.host}-wsl`
  return o
}

function fail(message) {
  console.error(`live-release: ${message}`)
  process.exit(2)
}

// Runs a command; streams redacted output to `log` (and stdout when `echo`), returns { code, out }.
function run(cmd, args, { input, log, echo = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const take = (chunk) => {
      const text = redact(chunk)
      out += text
      if (log) fs.appendFileSync(log, text)
      if (echo) process.stdout.write(text)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (error) => take(`${cmd}: ${error.message}\n`))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
    child.stdin.end(input ?? '')
  })
}

// ---------------------------------------------------------------------------------------------------------
// Beelink side.

async function observe(keyDir) {
  const { createHash } = await import('node:crypto')
  const { Sandbox } = await import('@tangle-network/sandbox')
  const apiKey = fs.readFileSync(path.join(home(keyDir), KEY_FILES.sandbox), 'utf8').trim()
  const client = new Sandbox({ baseUrl: LIVE_CONFIG.BRAID_TANGLE_SANDBOX_ENDPOINT, apiKey })
  const live = await client.list({ status: ['pending', 'provisioning', 'running'] })
  const created = (box) => new Date(box.createdAt).getTime()
  const newest = Math.max(0, ...live.map(created))
  const ageMin = newest === 0 ? Number.POSITIVE_INFINITY : (Date.now() - newest) / MINUTE
  const ids = createHash('sha256')
    .update(
      live
        .map((box) => box.id)
        .sort()
        .join(','),
    )
    .digest('hex')
    .slice(0, 12)
  const usage = await client.usage()
  const settled = ageMin >= SETTLED_AGE_MINUTES
  console.log(
    `${settled ? 'SETTLED' : 'BUSY'} ids=${ids} active=${usage.activeSandboxes} live=${live.length} newestAgeMin=${ageMin.toFixed(1)} at=${now()}`,
  )
  process.exit(settled ? 0 : 1)
}

function summarize(logFile, receiptsFile, evidenceDir, since) {
  const line = (tag, value, max = 1200) =>
    console.log(`${tag} ${redact(value).replace(/\s+/g, ' ').slice(0, max)}`)
  for (const flow of readJson(receiptsFile)?.flows ?? [])
    line('ROW', `${flow.row} ${flow.status}${flow.reason ? `: ${flow.reason}` : ''}`, 900)
  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
  for (const entry of text.split('\n')) {
    if (entry.startsWith('BRAID_RELEASE_RESULT_JSON=')) line('RESULT', entry.slice(26), 1500)
    if (entry.startsWith('BRAID_SANDBOX_SOAK_DIAGNOSTIC_JSON=')) line('SOAK', entry.slice(35), 2500)
    if (/Waiting .* usage period/.test(entry)) line('WAIT', entry, 300)
  }
  const files = fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir) : []
  for (const name of files.filter((f) => f.endsWith('.json')).sort()) {
    const file = path.join(evidenceDir, name)
    if (fs.statSync(file).mtimeMs < since) continue
    const r = readJson(file)
    if (r === undefined) {
      line('EVIDENCE', `${name} unreadable`)
      continue
    }
    const failed = Object.entries(r.phases ?? {})
      .filter(([, p]) => p?.status === 'failed')
      .map(([k, p]) => `${k}: ${p.error ?? ''}`)
    const failure = r.failure?.message ?? r.error ?? r.failure
    line(
      'EVIDENCE',
      `${name} status=${r.status}${failed.length ? ` failedPhases=${failed.join(' | ')}` : ''}${failure ? ` failure=${typeof failure === 'string' ? failure : JSON.stringify(failure)}` : ''}`,
      900,
    )
    for (const attempt of r.attempts ?? []) {
      const message = attempt?.proof?.failure?.message
      if (message)
        line(
          'ATTEMPT',
          `${name} #${attempt.index} ${attempt.status ?? attempt?.proof?.status}: ${message}`,
          900,
        )
    }
    for (const receipt of r.terminal?.permissions ?? [])
      line('PERMISSION', `${name} ${JSON.stringify(receipt)}`, 500)
  }
}

// LIVE-07 passed when its receipt row passed (receipts exist only when every row passed), or when the run's
// failure reason does not name the Tangle sandbox proof and this run wrote a passed multirun evidence file.
function live07Verdict(logFile, receiptsFile, evidenceDir, since) {
  const flow = readJson(receiptsFile)?.flows?.find((candidate) => candidate.row === 'LIVE-07')
  if (flow?.status === 'passed') return 'LIVE-07 passed (receipt row)'
  const multirun = (fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir) : [])
    .filter((name) => /^tangle-sandbox-braid-multirun-production-.*\.json$/.test(name))
    .map((name) => path.join(evidenceDir, name))
    .filter((file) => fs.statSync(file).mtimeMs >= since)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
  if (multirun === undefined) return undefined
  const resultLine = fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((entry) => entry.startsWith('BRAID_RELEASE_RESULT_JSON='))
    .at(-1)
  let result
  try {
    result = JSON.parse(resultLine.slice(26))
  } catch {
    return undefined
  }
  if (result.status === 'passed') return 'LIVE-07 passed (run passed)'
  const sandboxFailed = String(result.reason ?? '').includes('Tangle sandbox failed')
  if (!sandboxFailed && readJson(multirun)?.status === 'passed')
    return 'LIVE-07 passed (row; another row failed, see RESULT)'
  return undefined
}

async function liveRun(n, keyDir) {
  const dir = home(keyDir)
  const head = await run('git', ['rev-parse', 'HEAD'])
  console.log(`live-run run=${n} sha=${head.out.trim()} start=${now()}`)
  const build = await run('pnpm', ['run', 'build'])
  if (build.code !== 0) {
    console.log(`build failed\n${build.out.split('\n').slice(-20).join('\n')}`)
    process.exit(1)
  }
  const receipts = path.join(os.tmpdir(), `braid-live-release-receipts-${n}.json`)
  const logFile = path.join(os.tmpdir(), `braid-live-release-${n}.log`)
  fs.rmSync(receipts, { force: true })
  const key = (name) => fs.readFileSync(path.join(dir, name), 'utf8').trim()
  const env = { ...LIVE_CONFIG, ...process.env, BRAID_LIVE_TANGLE_RECEIPTS: receipts }
  env.BRAID_TANGLE_API_KEY = key(KEY_FILES.router)
  env.TANGLE_API_KEY = key(KEY_FILES.sandbox)
  const start = Date.now()
  const code = await new Promise((resolve) => {
    const out = fs.openSync(logFile, 'w')
    const child = spawn('node', ['scripts/live-required.mjs', 'live-tangle'], {
      env,
      stdio: ['ignore', out, out],
    })
    child.on('close', (c) => resolve(c ?? 1))
  })
  console.log(
    `live-tangle rc=${code} seconds=${Math.round((Date.now() - start) / 1000)} end=${now()}`,
  )
  const evidenceDir = 'artifacts/verification/live'
  summarize(logFile, receipts, evidenceDir, start)
  // Keep the raw log and receipts beside the keys (owner-only) for later reading.
  for (const [from, to] of [
    [logFile, `live-release-${n}.log`],
    [receipts, `live-release-receipts-${n}.json`],
  ]) {
    if (!fs.existsSync(from)) continue
    fs.copyFileSync(from, path.join(dir, to))
    fs.chmodSync(path.join(dir, to), 0o600)
  }
  const verdict = live07Verdict(logFile, receipts, evidenceDir, start)
  console.log(verdict ?? 'LIVE-07 failed')
  process.exit(verdict ? 0 : 1)
}

// ---------------------------------------------------------------------------------------------------------
// Operator side.

class Driver {
  constructor(o) {
    this.o = o
    this.deadline = Date.now() + o.hours * 60 * MINUTE
    this.t0 = now()
  }

  log(message) {
    const entry = `${now()} ${message}`
    console.log(entry)
    if (this.dir) fs.appendFileSync(path.join(this.dir, 'progress.txt'), `${entry}\n`)
  }

  finish(message, code = 1) {
    const entry = `RESULT ${message} (${now()})`
    this.log(entry)
    if (this.dir) fs.writeFileSync(path.join(this.dir, 'result.txt'), `${entry}\n`)
    process.exit(code)
  }

  async gh(args) {
    const r = await run(this.o.gh, args)
    if (r.code !== 0)
      throw new Error(
        `${this.o.gh} ${args.slice(0, 3).join(' ')} failed: ${r.out.trim().slice(0, 300)}`,
      )
    return r.out.trim()
  }

  gate(sha, command, log) {
    const { host } = this.o
    return run(
      'beelink-gate',
      ['--pin-host', '--retry', '60', '--summary', host, REPO_URL, sha, '--', ...command],
      {
        log,
      },
    )
  }

  async observe() {
    const remote = [
      'mkdir -p /tmp/braid-inspect && cd /tmp/braid-inspect',
      'ln -sfn ~/.cache/beelink-gate/github.com/tangle-network/braid/node_modules node_modules',
      `exec node --input-type=module - observe --key-dir ${this.o.keyDir}`,
    ].join(' && ')
    const source = fs.readFileSync(new URL(import.meta.url), 'utf8')
    const r = await run(
      'timeout',
      ['120', 'ssh', '-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', this.o.ssh, remote],
      {
        input: source,
      },
    )
    return r.out.trim().split('\n').at(-1) ?? ''
  }

  // Settled: no live Sandbox created in 10 minutes, and the same live-id set and active count 5 minutes later.
  async waitSettled() {
    const key = (obs) => obs.replace(/.*ids=(\S+) active=(\S+).*/, '$1 $2')
    while (Date.now() < this.deadline) {
      const a = await this.observe()
      this.log(`observe ${a}`)
      await sleep(5 * MINUTE)
      if (!a.startsWith('SETTLED')) continue
      const b = await this.observe()
      this.log(`observe ${b}`)
      if (b.startsWith('SETTLED') && key(a) === key(b)) return b
    }
    return undefined
  }

  async unreadReviews(pr) {
    const me = await this.gh(['api', 'user', '--jq', '.login'])
    const human = `select(.user.login!="${me}" and .user.type!="Bot" and ((.body // "")|test("Auto-approved PR")|not))`
    const count = (endpoint, filter) =>
      this.gh(['api', endpoint, '--paginate', '--jq', `[.[]|${filter}]|length`])
    const counts = [
      await count(`repos/${REPO}/issues/${pr}/comments?since=${this.t0}`, human),
      await count(
        `repos/${REPO}/pulls/${pr}/reviews`,
        `select(.submitted_at>"${this.t0}")|${human}`,
      ),
      await count(`repos/${REPO}/pulls/${pr}/comments?since=${this.t0}`, human),
    ]
    return counts.reduce(
      (sum, value) =>
        sum +
        value
          .split('\n')
          .map(Number)
          .reduce((a, b) => a + b, 0),
      0,
    )
  }

  async comment(pr, name, body) {
    const file = path.join(this.dir, name)
    fs.writeFileSync(file, body)
    if (!this.o.dryRun)
      await this.gh(['pr', 'comment', String(pr), '-R', REPO, '--body-file', file])
  }

  async waitRun(id) {
    while (Date.now() < this.deadline) {
      const s = await this.gh([
        'run',
        'view',
        String(id),
        '-R',
        REPO,
        '--json',
        'status,conclusion',
        '--jq',
        '.status+" "+.conclusion',
      ]).catch(() => '')
      if (s.startsWith('completed')) return s.slice('completed '.length)
      await sleep(45_000)
    }
    return 'timeout'
  }

  async dispatch(workflow, fields) {
    const after = now()
    await sleep(1000)
    const args = ['workflow', 'run', workflow, '-R', REPO, '--ref', 'main']
    for (const [k, v] of Object.entries(fields)) args.push('-f', `${k}=${v}`)
    await this.gh(args)
    for (let i = 0; i < 12; i++) {
      await sleep(10_000)
      const id = await this.gh([
        'run',
        'list',
        '-R',
        REPO,
        '--workflow',
        workflow,
        '-L',
        '10',
        '--json',
        'databaseId,createdAt',
        '--jq',
        `[.[]|select(.createdAt>"${after}")]|last|.databaseId // empty`,
      ])
      if (id) {
        this.log(
          `${workflow} ${JSON.stringify(fields)} https://github.com/${REPO}/actions/runs/${id}`,
        )
        const conclusion = await this.waitRun(id)
        this.log(`${workflow} run ${id}: ${conclusion}`)
        return { id, conclusion }
      }
    }
    return { id: undefined, conclusion: 'not found' }
  }

  // The LIVE-07 runs execute this file inside the gate checkout, so the PR head must contain it.
  hasLiveRun(sha) {
    return this.gh([
      'api',
      `repos/${REPO}/contents/scripts/release/live-release.mjs?ref=${sha}`,
      '--jq',
      '.sha',
    ])
      .then(() => true)
      .catch(() => false)
  }

  async preflight() {
    const files = Object.values(KEY_FILES)
      .map((f) => `${this.o.keyDir}/${f}`)
      .join(' ')
    const r = await run('ssh', [
      '-o',
      'ConnectTimeout=20',
      '-o',
      'BatchMode=yes',
      this.o.ssh,
      `stat -c '%a %n' ${files}`,
    ])
    this.log(
      `credential files on ${this.o.ssh}: ${r.code === 0 ? r.out.trim().replace(/\n/g, ', ') : `missing (${r.out.trim()})`}`,
    )
    if (r.code !== 0 || r.out.split('\n').some((l) => l && !l.startsWith('600 '))) return false
    this.log(`account now: ${await this.observe()}`)
    return true
  }

  async main() {
    const o = this.o
    let sha = o.commit
    let pr
    if (o.pr !== undefined) {
      pr = JSON.parse(
        await this.gh([
          'pr',
          'view',
          String(o.pr),
          '-R',
          REPO,
          '--json',
          'headRefOid,state,isDraft,baseRefName',
        ]),
      )
      if (pr.state !== 'OPEN') fail(`PR #${o.pr} is ${pr.state}`)
      sha = pr.headRefOid
    }
    sha ??= await this.gh(['api', `repos/${REPO}/commits/main`, '--jq', '.sha'])
    this.dir = path.join(os.homedir(), '.local/state/braid-live-release', sha)
    fs.mkdirSync(this.dir, { recursive: true })
    const target = pr ? `PR #${o.pr} head ${sha}` : `main commit ${sha}`
    this.log(`live release for ${target}; host ${o.host} (ssh ${o.ssh}); state ${this.dir}`)

    if (o.dryRun) {
      let ok = await this.preflight()
      if (pr && !(await this.hasLiveRun(sha))) {
        this.log(`PR head ${sha} lacks scripts/release/live-release.mjs; merge main into it first`)
        ok = false
      }
      const steps = [
        ...(pr
          ? [
              `code gate: beelink-gate --pin-host ${o.host} ${REPO_URL} ${sha} -- bash -c '<format, lint, typecheck, boundaries, live-required imports, pnpm test, test:property>'`,
              `${o.runs} LIVE-07 runs, each after a settled account: beelink-gate --pin-host ${o.host} ... ${sha} -- node scripts/release/live-release.mjs live-run <n> --key-dir ${o.keyDir}; stop at the first failure`,
              `comment the gate receipt and LIVE-07 results on PR #${o.pr}`,
              `at ${o.runs}/${o.runs}, head unchanged and no unread human review: ready, wait 5 min, re-check, ${o.gh} pr merge ${o.pr} --squash --match-head-commit ${sha}`,
            ]
          : []),
        `release.yml commit=${pr ? '<merge commit>' : sha} publish=false (candidate)`,
        'wait for a settled account',
        'release-live-evidence.yml commit, candidate_run_id (retried once after a settled account)',
        'release.yml publish=true live_evidence_run_id; read the npm latest dist-tag',
      ]
      for (const [i, step] of steps.entries()) console.log(`  ${i + 1}. ${step}`)
      this.finish(
        `dry run for ${target}: preflight ${ok ? 'ok' : 'FAILED'}; nothing dispatched`,
        ok ? 0 : 1,
      )
    }
    if (!(await this.preflight()))
      this.finish('preflight failed: credential files missing or not owner-only')

    let commit = sha
    if (pr && !(await this.hasLiveRun(sha)))
      this.finish(
        `PR #${o.pr} head ${sha} lacks scripts/release/live-release.mjs; merge main into it first`,
      )
    if (pr) commit = await this.verifyAndMerge(o.pr, sha)
    await this.release(commit)
  }

  async verifyAndMerge(number, sha) {
    const gateLog = path.join(this.dir, 'gate.log')
    const gate = await this.gate(sha, ['bash', '-c', CODE_GATE], gateLog)
    const receipt =
      gate.out
        .split('\n')
        .filter((l) => l.includes('beelink-gate receipt'))
        .at(-1) ?? ''
    this.log(`code gate rc=${gate.code} ${receipt.slice(0, 300)}`)
    if (gate.code !== 0) this.finish(`code gate failed rc=${gate.code} at ${sha}; see ${gateLog}`)
    const summary = gate.out
      .split('\n')
      .filter((l) => /^ℹ (tests|pass|fail)|-OK$/.test(l))
      .slice(0, 20)
    await this.comment(
      number,
      'gate-comment.md',
      `Code gate at \`${sha}\`: format:check, lint, typecheck, boundaries, an import of every \`scripts/live-required/*.mjs\`, \`pnpm test\` and \`pnpm run test:property\`. Exit 0.\n\n\`\`\`\n${[...summary, receipt.slice(0, 700)].join('\n')}\n\`\`\`\n`,
    )

    const runs = []
    for (let n = 1; n <= this.o.runs; n++) {
      const before = await this.waitSettled()
      if (before === undefined) break
      const log = path.join(this.dir, `run${n}.log`)
      const r = await this.gate(
        sha,
        [
          'node',
          'scripts/release/live-release.mjs',
          'live-run',
          String(n),
          '--key-dir',
          this.o.keyDir,
        ],
        log,
      )
      const after = await this.observe()
      runs.push({
        n,
        code: r.code,
        before,
        after,
        lines: r.out.split('\n').filter((l) => REPORT_LINE.test(l)),
      })
      this.log(`LIVE-07 run ${n} rc=${r.code}; account after: ${after}`)
      if (r.code !== 0) break
    }
    const passes = runs.filter((r) => r.code === 0).length
    const settledOut = runs.length < this.o.runs && runs.every((r) => r.code === 0)
    await this.comment(
      number,
      'live-comment.md',
      [
        `LIVE-07 consecutive runs at \`${sha}\` on ${this.o.host} (\`node scripts/live-required.mjs live-tangle\`, protected config, via \`scripts/release/live-release.mjs\`), each started only after the shared Sandbox account settled: **${passes}/${this.o.runs} passed** (${runs.length} attempted; stops at the first LIVE-07 failure).`,
        ...(settledOut
          ? [
              '',
              'The Sandbox account did not settle before the deadline, so the remaining runs did not start.',
            ]
          : []),
        ...runs.flatMap((r) => [
          '',
          `Run ${r.n}. Account before: \`${r.before}\`. After: \`${r.after}\`.`,
          '```',
          ...r.lines.map((l) => l.slice(0, 1500)).slice(0, 40),
          '```',
        ]),
      ].join('\n'),
    )
    if (passes < this.o.runs) this.finish(`LIVE-07 ${passes}/${this.o.runs} at ${sha}; not merged`)

    const head = await this.gh([
      'pr',
      'view',
      String(number),
      '-R',
      REPO,
      '--json',
      'headRefOid',
      '--jq',
      '.headRefOid',
    ])
    if (head !== sha)
      this.finish(`head moved to ${head} after LIVE-07 passed at ${sha}; not merged`)
    let unread = await this.unreadReviews(number)
    if (unread > 0)
      this.finish(
        `${unread} human review(s) or comment(s) on #${number} since ${this.t0}; read them first; not merged`,
      )
    await this.gh(['pr', 'ready', String(number), '-R', REPO]).catch((e) =>
      this.log(String(e.message)),
    )
    await sleep(5 * MINUTE)
    unread = await this.unreadReviews(number)
    if (unread > 0)
      this.finish(
        `${unread} review(s) or comment(s) arrived after ready; read them first; not merged`,
      )
    const mergeEnd = Date.now() + 60 * MINUTE
    for (;;) {
      const m = await run(this.o.gh, [
        'pr',
        'merge',
        String(number),
        '-R',
        REPO,
        '--squash',
        '--match-head-commit',
        sha,
      ])
      if (m.code === 0) break
      this.log(`merge refused: ${m.out.trim().slice(0, 300)}`)
      if (Date.now() >= mergeEnd) this.finish(`merge refused for 60 min at ${sha}`)
      await sleep(10 * MINUTE)
    }
    await sleep(15_000)
    const merged = await this.gh([
      'pr',
      'view',
      String(number),
      '-R',
      REPO,
      '--json',
      'mergeCommit',
      '--jq',
      '.mergeCommit.oid',
    ])
    this.log(`merged #${number} as ${merged}`)
    return merged
  }

  async release(commit) {
    const candidate = await this.dispatch('release.yml', { commit, publish: 'false' })
    if (candidate.conclusion !== 'success')
      this.finish(
        `candidate ${candidate.id} for ${commit} ended ${candidate.conclusion}; not published`,
      )
    let evidence
    for (let attempt = 1; attempt <= 2; attempt++) {
      const settled = await this.waitSettled()
      if (settled === undefined)
        this.finish(
          `candidate ${candidate.id} passed; account never settled for live evidence; not published`,
        )
      evidence = await this.dispatch('release-live-evidence.yml', {
        commit,
        candidate_run_id: candidate.id,
      })
      if (evidence.conclusion === 'success') break
    }
    if (evidence.conclusion !== 'success')
      this.finish(`live evidence ${evidence.id} ended ${evidence.conclusion} twice; not published`)
    const publish = await this.dispatch('release.yml', {
      commit,
      publish: 'true',
      live_evidence_run_id: evidence.id,
    })
    if (publish.conclusion !== 'success')
      this.finish(`publish ${publish.id} ended ${publish.conclusion}`)
    const latest = await fetch('https://registry.npmjs.org/@tangle-network/braid')
      .then((r) => r.json())
      .then((r) => r['dist-tags']?.latest)
      .catch(() => 'unknown')
    this.finish(
      `published ${commit}: npm latest ${latest}; publish run https://github.com/${REPO}/actions/runs/${publish.id}`,
      0,
    )
  }
}

const [mode, ...rest] = process.argv.slice(2)
const keyDirArg = (args) =>
  args.includes('--key-dir') ? args[args.indexOf('--key-dir') + 1] : '~/.braid-live'
if (mode === 'observe') await observe(keyDirArg(rest))
else if (mode === 'live-run') await liveRun(Number(rest[0]) || 1, keyDirArg(rest))
else await new Driver(parseArgs(process.argv.slice(2))).main()
