import { strict as assert } from 'node:assert'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function shellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function runDeterministicRpcProof(binary, repository) {
  const requests = [
    {
      version: 1,
      requestId: 'req-init',
      command: 'initialize',
      params: { workspace: repository, subscribe: true },
    },
    {
      version: 1,
      requestId: 'req-send',
      operationId: 'op-packed-rpc',
      command: 'send',
      params: { text: 'packed rpc proof' },
    },
    {
      version: 1,
      requestId: 'req-stop',
      operationId: 'op-packed-shutdown',
      command: 'shutdown',
    },
  ]
  const fifoRoot = await mkdtemp(join(tmpdir(), 'braid-rpc-proof-'))
  const stdoutPath = join(fifoRoot, 'stdout')
  const stderrPath = join(fifoRoot, 'stderr')
  const journalPath = join(repository, `.braid/test-rpc-${randomUUID()}.jsonl`)
  try {
    await execFileAsync('mkfifo', [stdoutPath, stderrPath])
    const requestLine = (request) => `printf '%s\\n' ${shellArgument(JSON.stringify(request))}`
    const shellCommand = `{ ${requestLine(requests[0])}; ${requestLine(requests[1])}; sleep 1; ${requestLine(requests[2])}; } | exec ${shellArgument(binary)} rpc --fixture deterministic > ${shellArgument(stdoutPath)} 2> ${shellArgument(stderrPath)}`
    const output = { value: '' }
    const error = { value: '' }
    const readFifo = (path, sink) =>
      new Promise((resolve, reject) => {
        const stream = createReadStream(path, { encoding: 'utf8' })
        stream.on('data', (chunk) => {
          sink.value += chunk
        })
        stream.on('error', reject)
        stream.on('end', resolve)
      })
    const session = spawn('/bin/sh', ['-c', shellCommand], {
      cwd: repository,
      env: {
        ...process.env,
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        BRAID_JOURNAL_PATH: journalPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let wrapperStderr = ''
    session.stdout.resume()
    session.stderr.setEncoding('utf8')
    session.stderr.on('data', (chunk) => {
      wrapperStderr += chunk
    })
    const exited = new Promise((resolve, reject) => {
      session.on('error', reject)
      session.on('close', (code, signal) => resolve({ code, signal }))
    })
    const timeout = setTimeout(() => session.kill(), 5_000)
    const [exit] = await Promise.all([
      exited,
      readFifo(stdoutPath, output),
      readFifo(stderrPath, error),
    ])
    clearTimeout(timeout)
    if (exit.code !== 0)
      throw new Error(`packed RPC exited ${exit.code}\n${wrapperStderr}${error.value}`)
    const stdout = output.value
    const stderr = `${wrapperStderr}${error.value}`
    if (stderr) throw new Error(`packed RPC wrote stderr: ${stderr}`)
    const normalized = stdout.replace(/\r\n/gu, '\n').replace(/\r/gu, '')
    if (!normalized.trim()) throw new Error(`packed RPC produced no stdout; stderr=${stderr}`)
    const lines = normalized.trim().split('\n')
    const responses = lines.map((line) => JSON.parse(line))
    const state = responses
      .filter((response) => response.type === 'state' && response.requestId === 'req-send')
      .at(-1)
    if (state?.state.messages.at(-1)?.text !== 'Fixture response through pi: packed rpc proof')
      throw new Error(`packed RPC semantic proof failed\n${stdout}`)
    if (lines.some((line) => !line.startsWith('{')))
      throw new Error('packed RPC wrote non-JSONL stdout')
    process.stdout.write(`Packed RPC proof passed: ${lines.length} JSONL responses\n`)
    const firstTask = await execFileAsync(
      process.execPath,
      [join(repository, 'examples/rpc-first-task.mjs'), '--fixture'],
      {
        cwd: repository,
        env: {
          ...process.env,
          BRAID_BIN: binary,
          NO_COLOR: '1',
          NODE_NO_WARNINGS: '1',
        },
      },
    )
    const firstTaskResult = JSON.parse(firstTask.stdout.trim())
    assert.equal(firstTaskResult.status, 'completed')
    assert.equal(
      firstTaskResult.output,
      'Fixture response through pi: Summarize the current workspace and suggest one next step.',
    )
    assert.equal(firstTaskResult.shutdownAcknowledged, true)
    process.stdout.write(
      `Packed first-task example passed with public output: ${firstTaskResult.runId}\n`,
    )

    const examplePath = join(repository, 'examples/rpc-first-task.mjs')
    const fakeBinary = join(repository, 'scripts/packed-rpc/fake-first-task.mjs')
    async function runFakeScenario(mode, extraEnv = {}) {
      const requestLog = join(fifoRoot, `${mode}-requests.jsonl`)
      const result = await execFileAsync(process.execPath, [examplePath], {
        cwd: repository,
        env: {
          ...process.env,
          BRAID_BIN: fakeBinary,
          BRAID_WORKSPACE: repository,
          BRAID_FIRST_TASK_FAKE_MODE: mode,
          BRAID_FIRST_TASK_FAKE_REQUEST_LOG: requestLog,
          NO_COLOR: '1',
          NODE_NO_WARNINGS: '1',
          ...extraEnv,
        },
        timeout: 15_000,
      }).catch((error) => {
        if (error.killed) throw new Error(`first-task scenario ${mode} exceeded its process bound`)
        return { code: error.code, stdout: error.stdout, stderr: error.stderr }
      })
      const requests = readFileSync(requestLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      return {
        code: result.code ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
        result: JSON.parse(result.stdout.trim()),
        requests,
      }
    }

    const priorWork = await runFakeScenario('active')
    assert.equal(priorWork.code, 1)
    assert.equal(priorWork.result.status, 'not_started')
    assert.match(priorWork.result.reason, /Existing queued, active, detached, or unknown work/u)
    assert.equal(
      priorWork.requests.some((request) => request.command === 'send'),
      false,
    )
    assert.equal(
      priorWork.requests.some((request) => request.command === 'cancel'),
      false,
    )
    assert.equal(
      priorWork.requests.some(
        (request) => request.command === 'shutdown' && request.params.mode === 'cancel',
      ),
      false,
    )
    assert.equal(priorWork.requests.at(-1)?.command, 'shutdown')
    assert.equal(priorWork.requests.at(-1)?.params.mode, 'wait')

    const interactionCancel = await runFakeScenario('interaction-cancel')
    assert.equal(interactionCancel.code, 1)
    assert.equal(interactionCancel.result.status, 'needs_input')
    assert.equal(interactionCancel.result.interaction.prompt, '[secret input is hidden]')
    assert.doesNotMatch(interactionCancel.stdout, /Do not print this secret prompt/u)
    assert.equal(interactionCancel.result.cleanup.action, 'cancel')
    assert.equal(interactionCancel.result.cleanup.confirmed, true)
    assert.equal(
      interactionCancel.requests.find((request) => request.command === 'cancel')?.params.runId,
      'run-example',
    )
    assert.equal(
      interactionCancel.requests.some((request) => request.command === 'respond_interaction'),
      false,
    )

    const interactionDetach = await runFakeScenario('interaction-detach')
    assert.equal(interactionDetach.code, 1)
    assert.equal(interactionDetach.result.status, 'needs_input')
    assert.equal(interactionDetach.result.cleanup.action, 'detach')
    assert.equal(interactionDetach.result.cleanup.confirmed, true)
    assert.equal(
      interactionDetach.requests.find((request) => request.command === 'detach')?.params.runId,
      'run-example',
    )
    assert.equal(
      interactionDetach.requests.some((request) => request.command === 'cancel'),
      false,
    )

    const timeoutScenario = await runFakeScenario('timeout', { BRAID_FIRST_TASK_TIMEOUT_MS: '1' })
    assert.equal(timeoutScenario.code, 1)
    assert.equal(timeoutScenario.result.status, 'timed_out')
    assert.equal(timeoutScenario.result.cleanup.action, 'cancel')
    assert.equal(timeoutScenario.result.cleanup.confirmed, true)
    assert.equal(
      timeoutScenario.requests.find((request) => request.command === 'cancel')?.params.runId,
      'run-example',
    )
    assert.equal(timeoutScenario.requests.at(-1)?.params.mode, 'wait')

    const ambiguousSend = await runFakeScenario('ambiguous-send')
    assert.equal(ambiguousSend.code, 1)
    assert.equal(ambiguousSend.result.status, 'submission_unknown')
    assert.equal(ambiguousSend.result.runId, 'run-example')
    assert.equal(
      ambiguousSend.result.operationId,
      ambiguousSend.requests.find((request) => request.command === 'send')?.operationId,
    )
    assert.equal(ambiguousSend.result.cleanup.action, 'cancel')
    assert.equal(ambiguousSend.result.cleanup.confirmed, true)
    assert.equal(
      ambiguousSend.requests.find((request) => request.command === 'cancel')?.params.runId,
      'run-example',
    )

    const noOutput = await runFakeScenario('missing-output')
    assert.equal(noOutput.code, 1)
    assert.equal(noOutput.result.status, 'missing_output')
    assert.equal('output' in noOutput.result, false)

    let missingBinary
    try {
      await execFileAsync(process.execPath, [examplePath], {
        cwd: repository,
        env: {
          ...process.env,
          BRAID_BIN: join(tmpdir(), `braid-missing-${randomUUID()}`),
          BRAID_WORKSPACE: repository,
          NO_COLOR: '1',
        },
        timeout: 3_000,
      })
    } catch (error) {
      missingBinary = error
    }
    assert.ok(missingBinary)
    assert.equal(missingBinary.killed, false)
    const missingBinaryResult = JSON.parse(missingBinary.stdout.trim())
    assert.equal(missingBinaryResult.status, 'not_started')
    assert.match(missingBinaryResult.error, /Install Braid or set BRAID_BIN/u)
    process.stdout.write(
      'Packed first-task edge proofs passed: prior work, interaction, timeout, ambiguous send, output, and ENOENT\n',
    )
  } finally {
    await rm(fifoRoot, { force: true, recursive: true })
    await rm(journalPath, { force: true })
  }
}
