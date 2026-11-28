/**
 * The randomized canary of learned procedure packs, through the `braid` binary.
 *
 * Invented history: six Claude Code sessions used `tidy`; four of them piped a
 * check's output into `tail`, three merged before reading the check's
 * receipt, and one stated a cause with no record. Five sessions used `notes`
 * and broke nothing. Braid learns a pack for `tidy` and none for `notes`,
 * seals the protocol into a ledger whose remote is a bare git repository, and
 * two checkouts of that ledger (two hosts) assign tasks, some of them at the
 * same moment. Every arm is the one the seed decides, a task asked for twice
 * keeps its first arm, the repository cap and the unknown skill turn tasks
 * away on the record. Sessions whose briefs carry two tasks' lines give those
 * tasks their procedure mistakes and tokens, and an edited entry breaks the
 * chain.
 */

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { sealRandomizedCanaryRule } from '@tangle-network/agent-eval/experiment'

const binary = resolve('dist/bin/braid.js')
const HOUR = 3_600_000

function session(
  directory: string,
  id: string,
  skill: string,
  commands: readonly string[],
  answer: string,
  options: { readonly request?: string; readonly startMs?: number } = {},
): void {
  const start = options.startMs ?? Date.now() - 24 * HOUR
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString()
  const records: unknown[] = []
  let parent: string | null = null
  const push = (record: Record<string, unknown>) => {
    const uuid = `${id}-${records.length}`
    records.push({
      parentUuid: parent,
      isSidechain: false,
      userType: 'external',
      cwd: '/work/app',
      sessionId: id,
      version: '0.0.0-fixture',
      uuid,
      timestamp: at(records.length),
      ...record,
    })
    parent = uuid
  }
  push({
    type: 'user',
    message: { role: 'user', content: options.request ?? 'Fixture request: change the module.' },
  })
  const usage = { input_tokens: 100, output_tokens: 10 }
  const tool = (toolId: string, name: string, input: unknown) => {
    push({
      type: 'assistant',
      message: {
        id: `msg-${toolId}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        usage,
        content: [{ type: 'tool_use', id: toolId, name, input }],
      },
    })
    push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }],
      },
    })
  }
  tool(`${id}-skill`, 'Skill', { skill })
  for (const [index, command] of commands.entries())
    tool(`${id}-bash-${index}`, 'Bash', { command })
  push({
    type: 'assistant',
    message: {
      id: `msg-${id}-end`,
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      usage,
      content: [{ type: 'text', text: answer }],
    },
  })
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${id}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  )
}

const CONTRACT = {
  name: 'fixture-procedures',
  rules: [
    {
      kind: 'never',
      label: 'check-output-piped',
      p: {
        kind: 'TOOL',
        attr: { 'input.value': { $regex: 'run-checks[^|]*\\|\\s*tail', flags: '' } },
      },
    },
    {
      kind: 'neverUnless',
      label: 'merge-before-receipt',
      p: { kind: 'TOOL', attr: { 'input.value': { $regex: 'merge-change', flags: '' } } },
      prior: { kind: 'TOOL', attr: { 'input.value': { $regex: 'read-receipt', flags: '' } } },
    },
    {
      kind: 'never',
      label: 'cause-without-record',
      p: {
        kind: 'LLM',
        attr: { 'output.value': { $regex: '^(?![\\s\\S]*`)[\\s\\S]*\\bbecause\\b', flags: 'i' } },
      },
    },
  ],
}
const PROCEDURES = {
  'check-output-piped': 'Read a check from its receipt; never pipe its output into tail.',
  'merge-before-receipt': 'Read the check receipt for the head commit before merging.',
  'cause-without-record': 'Name the output a cause was read from, or call it a guess.',
}

test('a learned pack is sealed, served to one arm, and every assignment holds across hosts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'braid-canary-'))
  try {
    const projects = join(root, 'claude', 'projects', '-work-app')
    const piped = 'run-checks --all | tail -5'
    const merged = 'merge-change 12'
    const clean = 'run-checks --all > checks.log'
    session(projects, 's1', 'tidy', [piped, merged], 'Merged because the checks passed.')
    session(projects, 's2', 'tidy', [piped, merged], 'Merged after `read-receipt` showed exit 0.')
    session(projects, 's3', 'tidy', [piped, 'read-receipt 12', merged], 'Merged; receipt read.')
    session(projects, 's4', 'tidy', [piped, merged], 'Done; receipt in `checks.log`.')
    session(projects, 's5', 'tidy', [clean, 'read-receipt 13', 'merge-change 13'], 'Merged.')
    session(projects, 's6', 'tidy', [clean], 'No change needed.')
    for (const id of ['n1', 'n2', 'n3', 'n4', 'n5'])
      session(projects, id, 'notes', [clean], 'Notes written.')

    const environment = {
      ...process.env,
      BRAID_LEARN_CLAUDE_CODE_PROJECTS: join(root, 'claude', 'projects'),
      BRAID_LEARN_CODEX_SESSIONS: join(root, 'codex-sessions'),
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      // The host's commit hooks still run on these throwaway ledgers; this is how they admit a fixture identity.
      GIT_ALLOW_TEST_IDENTITY: '1',
    }
    const braid = (args: readonly string[]) => {
      try {
        return {
          code: 0,
          out: execFileSync(process.execPath, [binary, ...args], {
            env: environment,
            encoding: 'utf8',
          }),
        }
      } catch (error) {
        const failed = error as { status: number; stdout: string; stderr: string }
        return { code: failed.status, out: `${failed.stdout}${failed.stderr}` }
      }
    }
    const json = (args: readonly string[]) => {
      const result = braid([...args, '--format', 'json'])
      return { code: result.code, value: JSON.parse(result.out) as Record<string, unknown> }
    }

    writeFileSync(join(root, 'contract.json'), JSON.stringify(CONTRACT))
    writeFileSync(join(root, 'procedures.json'), JSON.stringify(PROCEDURES))
    const packs = join(root, 'packs')
    const learned = json([
      'canary',
      'pack',
      '--contract',
      join(root, 'contract.json'),
      '--procedures',
      join(root, 'procedures.json'),
      '--out',
      packs,
      '--days',
      '7',
    ])
    assert.equal(learned.code, 0, JSON.stringify(learned.value))
    const tidy = (
      learned.value.learned as Record<
        string,
        { sessions: number; rules: { rule: string; sessions: number }[]; file: string | null }
      >
    ).tidy
    assert.deepEqual(tidy?.rules, [
      { rule: 'check-output-piped', sessions: 4 },
      { rule: 'merge-before-receipt', sessions: 3 },
      { rule: 'cause-without-record', sessions: 1 },
    ])
    const notes = (
      learned.value.learned as Record<string, { sessions: number; file: string | null }>
    ).notes
    assert.equal(notes?.sessions, 5)
    assert.equal(notes?.file, null, 'a skill whose sessions broke nothing gets no pack')
    const packText = readFileSync(join(packs, tidy?.file as string), 'utf8')
    assert.match(packText, /Braid read 6 sessions .* that used tidy\./u)
    assert.match(
      packText,
      /- Read a check from its receipt; never pipe its output into tail\. \(broken in 4 of 6 sessions\)/u,
    )
    assert.match(
      packText,
      /- Read the check receipt for the head commit before merging\. \(broken in 3 of 6 sessions\)/u,
    )
    assert.doesNotMatch(
      packText,
      /Name the output/u,
      'a procedure one session broke stays out of the pack',
    )

    // The ledger's remote, and two checkouts of it: two hosts assigning tasks.
    const remote = join(root, 'ledger.git')
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch', 'main', remote])
    const checkout = (name: string) => {
      const directory = join(root, name)
      execFileSync('git', ['clone', '--quiet', remote, directory], {
        env: environment,
        stdio: 'ignore',
      })
      return directory
    }
    const seed = join(root, 'seed')
    const seedBytes = randomBytes(32)
    writeFileSync(seed, seedBytes, { mode: 0o600 })
    const config = (directory: string) => {
      const path = join(root, `${directory.split('/').at(-1)}-config.json`)
      writeFileSync(path, JSON.stringify({ ledger: join(directory, 'ledger.jsonl'), seed, packs }))
      return path
    }
    const hostA = config(checkout('host-a'))
    const hostB = config(checkout('host-b'))

    const cutoff = new Date(Date.now() + 28 * 24 * HOUR).toISOString()
    const protocol = {
      experimentId: 'fixture-canary',
      question: 'Does a learned procedure pack raise the checked success of delegated tasks?',
      eligibility: {
        unit: 'a delegated task brief naming one skill and one repository',
        repositoryCap: 2,
      },
      served: { braidVersion: '0.0.0-fixture', braidCommit: 'f'.repeat(40) },
      outcome: {
        definition: 'merged with its own tests green and no fix within 7 days',
        checkerDigest: `sha256:${'c'.repeat(64)}`,
      },
      secondary: { contractDigest: learned.value.contractDigest },
      readoutAt: new Date(Date.parse(cutoff) + 14 * 24 * HOUR).toISOString(),
      analysis: {
        populationId: 'fixture-briefs',
        randomizationSourceId: 'fixture-ledger',
        assignmentLedgerAuthorityId: 'fixture-remote',
        confirmatoryFamilyId: 'fixture-family',
        confirmatoryFamilySize: 1,
        confirmatoryIndex: 1,
        familyReservationSourceId: 'fixture-family-slot',
        stoppingRule: 'fixed-time',
        analysisCutoff: cutoff,
        outcomeMaturityMs: 14 * 24 * HOUR,
        minimumLift: 0,
        minimumClusters: 40,
      },
    }
    writeFileSync(join(root, 'protocol.json'), JSON.stringify(protocol))
    const before = braid([
      'assign',
      'task-0',
      '--skill',
      'tidy',
      '--repository',
      'example/one',
      '--config',
      hostA,
    ])
    assert.equal(before.code, 1, 'nothing is assigned before the seal')
    assert.match(before.out, /no sealed protocol/u)
    const sealed = json([
      'canary',
      'seal',
      '--protocol',
      join(root, 'protocol.json'),
      '--config',
      hostA,
    ])
    assert.equal(sealed.code, 0, JSON.stringify(sealed.value))
    const twice = braid([
      'canary',
      'seal',
      '--protocol',
      join(root, 'protocol.json'),
      '--config',
      hostB,
    ])
    assert.equal(twice.code, 1, 'a ledger is sealed once')
    assert.match(twice.out, /already holds a sealed protocol/u)

    // The seal is agent-eval's: re-sealing the registered rule gives the recorded digest.
    const ledgerA = join(root, 'host-a', 'ledger.jsonl')
    const genesis = JSON.parse(readFileSync(ledgerA, 'utf8').split('\n')[0] as string)
    assert.equal(
      sealRandomizedCanaryRule(genesis.protocol.rule).digest,
      sealed.value.protocolDigest,
    )
    assert.equal(genesis.protocol.rule.assignmentUnit, 'task')
    assert.equal(genesis.protocol.rule.clusterUnit, 'repository')
    const manifest = learned.value.skills as Record<string, { digest: string }>
    assert.deepEqual(Object.keys(manifest), ['tidy'])
    assert.equal(genesis.protocol.eligibility.skills.tidy, manifest.tidy?.digest)

    const expectedArm = (taskId: string) =>
      ((createHmac('sha256', seedBytes)
        .update(`fixture-canary\u0000${taskId}`)
        .digest()[0] as number) &
        1) ===
      1
        ? 'candidate'
        : 'control'
    const assignAsync = (taskId: string, repository: string, host: string) =>
      new Promise<Record<string, unknown>>((done, fail) => {
        execFile(
          process.execPath,
          [
            binary,
            'assign',
            taskId,
            '--skill',
            'tidy',
            '--repository',
            repository,
            '--config',
            host,
            '--format',
            'json',
          ],
          { env: environment, encoding: 'utf8' },
          (error, stdout) => {
            if (error) fail(new Error(`${taskId}: ${stdout}${error.message}`))
            else done(JSON.parse(stdout))
          },
        )
      })
    // Ten tasks over five repositories, two at a time, one from each host.
    const results: Record<string, unknown>[] = []
    for (let pair = 0; pair < 5; pair++) {
      results.push(
        ...(await Promise.all([
          assignAsync(`task-${2 * pair}`, `example/repo-${pair}`, hostA),
          assignAsync(`task-${2 * pair + 1}`, `example/repo-${pair}`, hostB),
        ])),
      )
    }
    for (const [index, result] of results.entries()) {
      assert.equal(result.status, 'assigned')
      assert.equal(result.arm, expectedArm(`task-${index}`))
      assert.match(String(result.assignmentLine), /^Braid-Assignment: ba-[0-9a-f]{16}$/u)
      if (result.arm === 'candidate') {
        assert.equal(result.pack, packText)
        assert.ok(String(result.append).startsWith(packText.trimEnd()))
      } else {
        assert.equal(result.pack, null)
        assert.doesNotMatch(String(result.append), /Procedures learned/u)
      }
      assert.ok(String(result.append).endsWith(String(result.assignmentLine)))
    }
    assert.ok(
      results.some((result) => result.arm === 'candidate') &&
        results.some((result) => result.arm === 'control'),
    )

    // The same task from the other host keeps its arm; the cap and an unknown skill turn tasks away.
    const again = json([
      'assign',
      'task-3',
      '--skill',
      'tidy',
      '--repository',
      'example/repo-1',
      '--config',
      hostA,
    ])
    assert.equal(again.value.status, 'existing')
    assert.equal(again.value.assignmentId, results[3]?.assignmentId)
    const capped = json([
      'assign',
      'task-10',
      '--skill',
      'tidy',
      '--repository',
      'example/repo-0',
      '--config',
      hostA,
    ])
    assert.equal(capped.code, 3)
    assert.match(String(capped.value.reason), /example\/repo-0 already holds 2 assignments/u)
    const unknown = json([
      'assign',
      'task-11',
      '--skill',
      'notes',
      '--repository',
      'example/repo-9',
      '--config',
      hostB,
    ])
    assert.equal(unknown.code, 3)
    assert.match(String(unknown.value.reason), /no sealed pack for the skill notes/u)

    const status = json(['canary', 'status', '--config', hostB]).value
    assert.equal(status.protocolDigest, sealed.value.protocolDigest)
    assert.deepEqual(status.assignments, {
      control: results.filter((result) => result.arm === 'control').length,
      candidate: results.filter((result) => result.arm === 'candidate').length,
    })
    assert.equal(status.repositories, 5)
    assert.equal(status.dispositions, 2)
    assert.equal(status.entries, 13)

    // Two sessions did task-1 and one did task-2; their briefs carry the lines. Observe reads
    // their procedure mistakes under the sealed contract and their tokens; a task no session
    // here did stays unknown, and a contract other than the sealed one is refused.
    const brief = (index: number) => `Fixture brief.\n\n${String(results[index]?.append)}`
    const now = Date.now()
    session(projects, 'o1', 'tidy', [piped, merged], 'Merged after `read-receipt`.', {
      request: brief(1),
      startMs: now,
    })
    session(projects, 'o2', 'tidy', [clean], 'Checked.', { request: brief(1), startMs: now })
    session(projects, 'o3', 'tidy', [clean, 'read-receipt 3', 'merge-change 3'], 'Merged.', {
      request: brief(2),
      startMs: now,
    })
    const observed = json([
      'canary',
      'observe',
      '--contract',
      join(root, 'contract.json'),
      '--config',
      hostB,
    ])
    assert.equal(observed.code, 0, JSON.stringify(observed.value))
    type Observed = {
      assignmentId: string
      sessions: { sessionId: string; modelCalls: number }[]
      procedureMistakes: number | null
      mistakesByRule: Record<string, number> | null
      inputTokens: number | null
      outputTokens: number | null
      wallMs: number | null
    }
    const rows = new Map(
      (observed.value.rows as Observed[]).map((row) => [row.assignmentId, row] as const),
    )
    const one = rows.get(String(results[1]?.assignmentId)) as Observed
    assert.deepEqual(one.sessions.map((row) => row.sessionId).sort(), ['o1', 'o2'])
    assert.equal(one.procedureMistakes, 2)
    assert.equal(one.mistakesByRule?.['check-output-piped'], 1)
    assert.equal(one.mistakesByRule?.['merge-before-receipt'], 1)
    const calls = one.sessions.reduce((total, row) => total + row.modelCalls, 0)
    assert.ok(calls > 0)
    assert.deepEqual([one.inputTokens, one.outputTokens], [100 * calls, 10 * calls])
    assert.ok((one.wallMs ?? 0) > 0)
    const two = rows.get(String(results[2]?.assignmentId)) as Observed
    assert.deepEqual([two.sessions.length, two.procedureMistakes], [1, 0])
    const none = rows.get(String(results[0]?.assignmentId)) as Observed
    assert.deepEqual(
      [none.sessions.length, none.procedureMistakes, none.inputTokens, none.wallMs],
      [0, null, null, null],
    )
    writeFileSync(
      join(root, 'other-contract.json'),
      JSON.stringify({ ...CONTRACT, name: 'other-procedures' }),
    )
    const other = braid([
      'canary',
      'observe',
      '--contract',
      join(root, 'other-contract.json'),
      '--config',
      hostB,
    ])
    assert.equal(other.code, 1)
    assert.match(other.out, /sealed procedure contract/u)

    // The remote holds every entry, in one chain; an edited entry is refused.
    const reader = checkout('reader')
    const lines = readFileSync(join(reader, 'ledger.jsonl'), 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 13)
    const edited = lines.map((line, index) =>
      index === 4
        ? line.replace(
            /"arm":"(control|candidate)"/u,
            (_, arm) => `"arm":"${arm === 'control' ? 'candidate' : 'control'}"`,
          )
        : line,
    )
    writeFileSync(join(reader, 'ledger.jsonl'), `${edited.join('\n')}\n`)
    execFileSync('git', ['-C', reader, 'commit', '--quiet', '-am', 'edit'], { env: environment })
    execFileSync('git', ['-C', reader, 'push', '--quiet', 'origin', 'HEAD:main'], {
      env: environment,
    })
    const refused = braid(['canary', 'status', '--config', hostA])
    assert.equal(refused.code, 1)
    assert.match(refused.out, /ledger entry 5 was edited/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
