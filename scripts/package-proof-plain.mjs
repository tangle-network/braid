import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { cleanEnvironment, sleep, waitFor } from './package-proof-runtime.mjs'

const PROMPT = 'plain package proof'
const RESPONSE = `run.finished; status: completed: Fixture response through pi: ${PROMPT}`
const CANCEL_PROMPT = 'cancel from plain package proof'

function admittedRequest(prompt) {
  return `run.requested; status: admitted: ${prompt}`
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function occurrences(text, value) {
  return text.split(value).length - 1
}

function settledCompletions(text) {
  return Math.min(
    occurrences(text, RESPONSE),
    occurrences(text, 'effect.upserted; status: completed'),
  )
}

export async function runPlain(binary, cwd) {
  const recordPath = join(cwd, 'plain-final-state.json')
  const child = spawn(
    binary,
    [
      '--plain',
      '--fixture',
      'deterministic',
      '--no-color',
      '--workspace',
      cwd,
      '--record-state',
      recordPath,
    ],
    {
      cwd,
      env: cleanEnvironment({
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        BRAID_FIXTURE_CHUNK_DELAY_MS: '100',
        BRAID_JOURNAL_PATH: join(cwd, 'plain-events.jsonl'),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  let spawnError
  let closed = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.once('error', (error) => {
    spawnError = error
  })
  child.stdin.on('error', (error) => {
    spawnError ??= error
  })
  const exited = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      closed = true
      resolve({ code, signal })
    })
  })
  const waitForOutput = async (predicate, label) => {
    await waitFor(
      () => {
        if (spawnError) throw spawnError
        if (closed && !predicate()) throw new Error(`plain process exited before ${label}`)
        return predicate()
      },
      label,
      10_000,
    )
  }
  const writeLine = async (line) => {
    if (spawnError) throw spawnError
    if (closed || child.stdin.destroyed) throw new Error(`plain process closed before ${line}`)
    if (!child.stdin.write(`${line}\n`)) await once(child.stdin, 'drain')
  }

  try {
    await waitForOutput(() => stdout.includes('Braid ready'), 'plain startup')

    await writeLine(PROMPT)
    await waitForOutput(() => occurrences(stdout, RESPONSE) >= 1, 'first plain completion')
    await waitForOutput(() => settledCompletions(stdout) >= 1, 'first plain settlement')

    await writeLine('/graph')
    await writeLine(PROMPT)
    await waitForOutput(
      () => occurrences(stdout, admittedRequest(PROMPT)) >= 2,
      'plain retry start',
    )
    await writeLine('/steer deterministic package proof')
    await waitForOutput(
      () => /error: .*steering.*support/iu.test(stdout),
      'plain unavailable steering result',
    )
    await waitForOutput(() => occurrences(stdout, RESPONSE) >= 2, 'plain retry completion')
    await waitForOutput(() => settledCompletions(stdout) >= 2, 'plain retry settlement')

    await writeLine(CANCEL_PROMPT)
    await waitForOutput(
      () => stdout.includes(admittedRequest(CANCEL_PROMPT)),
      'plain cancellation start',
    )
    await writeLine('/cancel')
    await waitForOutput(
      () => stdout.includes('run.control.acknowledged; status: cancelling: CONTROL_ACKNOWLEDGED'),
      'plain cancellation acknowledgement',
    )
    await writeLine('/graph')
    await writeLine('/quit')
    child.stdin.end()

    const exit = await Promise.race([
      exited,
      sleep(10_000).then(() => {
        throw new Error('plain proof did not exit')
      }),
    ])
    assert(exit.code === 0, `plain process exited ${exit.code ?? exit.signal}`)
    assert(stderr === '', `plain mode wrote stderr: ${stderr}`)

    const evidence = JSON.parse(await readFile(recordPath, 'utf8'))
    assert(evidence.view?.selectedSurface === 'graph', 'plain graph command did not open graph')
    assert(
      evidence.state.runs.some((run) => run.status === 'aborted'),
      'plain cancel did not abort a run',
    )
    assert(
      evidence.state.messages.filter(
        (message) =>
          message.role === 'assistant' &&
          message.status === 'complete' &&
          message.text === `Fixture response through pi: ${PROMPT}`,
      ).length >= 2,
      'plain retry did not complete',
    )
    return {
      stdout,
      stderr,
      evidence,
      flows: ['send', 'graph', 'unavailable', 'retry', 'cancel', 'shutdown'],
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nplain stdout:\n${stdout}\nplain stderr:\n${stderr}`,
      { cause: error },
    )
  } finally {
    if (!closed) {
      child.kill('SIGTERM')
      await exited
    }
  }
}
