import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { jsonRequest } from './live-demo/http.mjs'
import { assertExactPackageProof, safeManifestAnalysis } from './live-demo/manifest.mjs'
import { assertPublicCapture } from './live-demo/public-safety.mjs'
import {
  createCapturedTerminal,
  terminalPageProgress,
  visibleModelCallNumbers,
} from './live-demo/terminal.mjs'

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isAlive(pid)
}

async function waitForPid(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(path, 'utf8'), 10)
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {
      // The child has not published its pid yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for child pid at ${path}`)
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
    server.closeAllConnections?.()
  })
}

test('analysis pagination reaches real page bounds and records visible calls', () => {
  assert.deepEqual(terminalPageProgress('model call #1\npage 1/2'), { current: 1, total: 2 })
  assert.deepEqual(terminalPageProgress('page 1/2\nfooter page 2/3'), { current: 2, total: 3 })
  assert.equal(terminalPageProgress('page 0/2'), undefined)
  assert.equal(terminalPageProgress('page 3/2'), undefined)
  assert.equal(terminalPageProgress('one page'), undefined)
  assert.deepEqual(visibleModelCallNumbers('model call #4\nmodel call #2\nmodel call #4'), [2, 4])
})

test('jsonRequest aborts a response that never finishes', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"status":')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  try {
    const startedAt = performance.now()
    await assert.rejects(
      Promise.race([
        jsonRequest(`http://127.0.0.1:${address.port}`, 100),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('jsonRequest exceeded its test bound')), 1_500),
        ),
      ]),
      /aborted|timeout|fetch failed|test bound/iu,
    )
    assert.ok(performance.now() - startedAt < 1_500)
  } finally {
    await closeServer(server)
  }
})

test('live manifest uses the typed public analysis execution view', () => {
  const record = {
    state: { analyses: [] },
    view: {
      activity: [{ kind: 'analysis', status: 'complete', entityId: 'analysis-live' }],
      entityDetails: [
        {
          entityType: 'analysis',
          entityId: 'analysis-live',
          status: 'completed',
          lines: ['• [citation-1] Complete finding'],
          analysisExecution: {
            configuredModel: 'tangle-router/glm-5.2',
            observedModels: ['glm-5.2'],
            modelCalls: [
              {
                sequence: 1,
                model: 'glm-5.2',
                inputTokens: 12,
                outputTokens: 7,
                tokensKnown: true,
                costUsd: 0.002,
                costStatus: 'observed',
                latencyMs: 321,
                outcome: 'succeeded',
              },
            ],
            wallTimeMs: 654,
          },
        },
      ],
      sessionUsage: {
        analyses: {
          sourceCount: 1,
          input: 12,
          output: 7,
          estimatedCostUsd: 0.002,
          costStatus: 'estimated',
        },
      },
    },
  }
  assert.deepEqual(safeManifestAnalysis(record), {
    id: 'analysis-live',
    status: 'completed',
    findings: 1,
    configuredModel: 'tangle-router/glm-5.2',
    observedModels: ['glm-5.2'],
    modelCalls: 1,
    inputTokens: 12,
    outputTokens: 7,
    costUsd: null,
    estimatedCostUsd: 0.002,
    costStatus: 'estimated',
    modelCallEvidence: [
      {
        sequence: 1,
        model: 'glm-5.2',
        inputTokens: 12,
        outputTokens: 7,
        tokensKnown: true,
        costUsd: 0.002,
        costStatus: 'observed',
        latencyMs: 321,
        outcome: 'succeeded',
      },
    ],
    modelLatencyMs: 321,
    wallTimeMs: 654,
  })
})

test('live demo accepts only the exact package proof', () => {
  const proof = {
    gitCommit: 'a'.repeat(40),
    version: '0.1.0',
    tarball: 'tangle-network-braid-0.1.0.tgz',
    sha256: 'b'.repeat(64),
  }
  const expected = {
    commit: proof.gitCommit,
    version: proof.version,
    tarball: proof.tarball,
    tarballSha256: proof.sha256,
  }

  assert.doesNotThrow(() => assertExactPackageProof(proof, expected))
  for (const [field, value] of [
    ['commit', 'c'.repeat(40)],
    ['version', '0.1.1'],
    ['tarball', 'other.tgz'],
    ['tarballSha256', 'd'.repeat(64)],
  ]) {
    assert.throws(
      () => assertExactPackageProof(proof, { ...expected, [field]: value }),
      /package proof/iu,
    )
  }
})

test('public capture rejects the credential patterns mirrored from the sanitizer', async (t) => {
  const filler = 'A'.repeat(32)
  const cases = [
    ['API key assignment', `api${'_key'}=${filler}`],
    ['Bearer value', `Bearer ${'B'.repeat(24)}`],
    ['OpenAI-style key', `${'s' + 'k-'}${filler}`],
    ['GitHub classic token', `gh${'p_'}${filler.slice(0, 20)}`],
    ['GitHub fine-grained token', `github${'_pat_'}${filler.slice(0, 20)}`],
    ['AWS access key', `${'AK' + 'IA'}${filler.slice(0, 16)}`],
    ['Google AI key', `${'A' + 'Iza'}${filler}`],
  ]
  for (const [label, value] of cases) {
    await t.test(label, () => {
      assert.throws(() => assertPublicCapture(value), /Public capture contains/iu)
    })
  }
  for (const variant of ['b', 'a', 'p', 'r', 's']) {
    await t.test(`Slack xox${variant} token`, () => {
      const value = `xox${variant}-${filler.slice(0, 20)}`
      assert.throws(() => assertPublicCapture(value), /Public capture contains/iu)
    })
  }
  assert.doesNotThrow(() => assertPublicCapture('public demo output with no credentials'))
})

test('PTY disposal escalates after SIGTERM and waits for the child exit event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-live-demo-test-'))
  const childPath = join(root, 'ignore-termination.mjs')
  const descendantPath = join(root, 'ignore-termination-descendant.mjs')
  const pidPath = join(root, 'child.pid')
  const descendantPidPath = join(root, 'descendant.pid')
  const termPath = join(root, 'sigterm.seen')
  let terminal
  let childPid
  let descendantPid
  let disposed = false
  await writeFile(
    descendantPath,
    [
      "import { writeFileSync } from 'node:fs'",
      "process.on('SIGTERM', () => {})",
      "process.on('SIGHUP', () => {})",
      "process.on('SIGINT', () => {})",
      'writeFileSync(process.env.DESCENDANT_PID_PATH, String(process.pid))',
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'),
  )
  await writeFile(
    childPath,
    [
      "import { writeFileSync } from 'node:fs'",
      "import { spawn } from 'node:child_process'",
      "process.on('SIGTERM', () => writeFileSync(process.env.TERM_PATH, 'seen'))",
      "process.on('SIGHUP', () => {})",
      "process.on('SIGINT', () => {})",
      'writeFileSync(process.env.PID_PATH, String(process.pid))',
      "spawn(process.execPath, [process.env.DESCENDANT_PATH], { env: process.env, stdio: 'ignore' })",
      "process.stdout.write('ready\\n')",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'),
  )
  try {
    terminal = await createCapturedTerminal({
      binary: childPath,
      args: [],
      cwd: root,
      columns: 80,
      rows: 24,
      recordPath: join(root, 'frame.json'),
      environment: {
        PID_PATH: pidPath,
        TERM_PATH: termPath,
        DESCENDANT_PATH: descendantPath,
        DESCENDANT_PID_PATH: descendantPidPath,
      },
    })
    await terminal.waitForScreen((screen) => screen.includes('ready'), 'termination test child')
    childPid = Number.parseInt(await readFile(pidPath, 'utf8'), 10)
    descendantPid = await waitForPid(descendantPidPath, 1_500)
    assert.ok(Number.isInteger(childPid) && childPid > 0)
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0)

    await terminal.dispose()
    disposed = true

    assert.equal(await readFile(termPath, 'utf8'), 'seen')
    assert.equal(await waitForGone(childPid, 500), true)
    assert.equal(await waitForGone(descendantPid, 500), true)
  } finally {
    if (childPid !== undefined && isAlive(childPid)) process.kill(childPid, 'SIGKILL')
    if (descendantPid !== undefined && isAlive(descendantPid))
      process.kill(descendantPid, 'SIGKILL')
    if (!disposed) await terminal?.dispose().catch(() => {})
    await rm(root, { force: true, recursive: true })
  }
})
