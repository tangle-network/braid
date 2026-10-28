// The packed Braid terminal driven in a PTY: screen, recording, input, readiness and exit.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { sleep } from '../live-bridge/process.mjs'
import {
  processTreeEnvironment,
  terminateTrackedProcessTree,
  trackProcessTree,
  waitForTreeGone,
} from '../live-bridge/process-tree.mjs'
import { castFor } from '../live-demo/terminal.mjs'
import { countProtectedWork } from '../proof-tools.mjs'
import { safeMessage } from './contracts.mjs'
import {
  createTerminalOutputTracker,
  harnessScreenState,
  waitForHarnessTerminalReady,
  waitForTerminalQuiescence,
} from './terminal-quiescence.mjs'

const SUBMIT_PAUSE_MS = 250
// Each harness's own composer prefix for a shell command without a model turn; Pi's is `!!`.
const SHELL_PREFIX = Object.freeze({ pi: '!!', 'claude-code': '!' })

/** Rewrites the Pi-form `!!` shell command of the frozen LIVE-08 sequence for the runner. */
export function harnessCommand(command, runner) {
  return command.startsWith('!!') ? `${SHELL_PREFIX[runner]}${command.slice(2)}` : command
}

/** The rows on screen; buffer rows above the viewport are scrollback the user cannot see. */
export function terminalText(terminal) {
  const buffer = terminal.buffer.active
  let text = ''
  for (let row = 0; row < terminal.rows; row += 1) {
    text += buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    text += '\n'
  }
  return text
}

export async function waitForValue(label, predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    countProtectedWork('polls')
    const value = await predicate()
    if (value) return value
    if (performance.now() >= deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`)
    await sleep(50)
  }
}

/** One process group's members for evidence: pid, age and a redacted, bounded command line. */
function processGroupMembers(processGroupId) {
  try {
    const listing = execFileSync('ps', ['-eo', 'pid=,pgid=,etime=,args='], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    return listing
      .split('\n')
      .map((line) => line.trim().split(/\s+/u))
      .filter(([, pgid]) => Number(pgid) === processGroupId)
      .slice(0, 16)
      .map(([pid, , etime, ...args]) => ({
        pid: Number(pid),
        etime,
        command: safeMessage(args.join(' ')).slice(0, 200),
      }))
  } catch {
    return []
  }
}

export function createPty(binary, config, statePath, exitTimeoutMs, runner) {
  const screenState = harnessScreenState(runner)
  const startedAt = performance.now()
  // Asciicast v2 events for the terminal recording.
  const events = []
  const record = (direction, data) =>
    events.push([Number(((performance.now() - startedAt) / 1000).toFixed(6)), direction, data])
  const terminal = new xterm.Terminal({ cols: 120, rows: 36, allowProposedApi: true })
  const environment = processTreeEnvironment({
    ...config.environment,
    BRAID_SHUTDOWN_MODE: 'detach',
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
  })
  const child = pty.spawn(process.execPath, [binary, '--inline', '--record-state', statePath], {
    cwd: config.workspace,
    env: environment.environment,
    name: 'xterm-256color',
    cols: 120,
    rows: 36,
  })
  trackProcessTree(child, environment.token)
  let output = ''
  let exited = false
  let exitResult
  let processCleanup
  let workspaceTrustAnswered = false
  const outputTracker = createTerminalOutputTracker()
  // Braid exits first. A group member still present after the wait (slow teardown on a loaded
  // host) is named and terminated, so cleanup stays exact instead of refusing; LIVE-08 at 23330bc
  // refused cleanup on one. Only a member that outlives SIGKILL still fails the proof.
  const waitForProcessCleanup = async () => {
    if (processCleanup !== undefined) return processCleanup
    const waited = await waitForTreeGone(child, exitTimeoutMs)
    if (!waited.supported || waited.gone) {
      processCleanup = waited
      return processCleanup
    }
    const survivors = processGroupMembers(child.pid)
    const termination = await terminateTrackedProcessTree(child, {
      termTimeoutMs: Math.min(1_000, exitTimeoutMs),
      killTimeoutMs: exitTimeoutMs,
    })
    processCleanup = { ...termination.tree, survivors }
    return processCleanup
  }
  child.onData((chunk) => {
    output += chunk
    record('o', chunk)
    outputTracker.observe(chunk, (settle) => terminal.write(chunk, settle))
  })
  child.onExit((result) => {
    exited = true
    exitResult = result
  })
  return {
    child,
    terminal,
    get output() {
      return output
    },
    get screen() {
      return terminalText(terminal)
    },
    get exited() {
      return exited || (processCleanup?.supported === true && processCleanup.gone === true)
    },
    get processCleanup() {
      return processCleanup
    },
    get terminalOutputRevision() {
      return outputTracker.snapshot().revision
    },
    waitForTerminalQuiescence(timeoutMs, afterRevision) {
      return waitForTerminalQuiescence(outputTracker, { timeoutMs, afterRevision, pause: sleep })
    },
    cast(title) {
      return castFor({ events, columns: 120, rows: 36 }, title, 'braid --inline')
    },
    get workspaceTrustAnswered() {
      return workspaceTrustAnswered
    },
    // Sandbox does not yet pre-trust the interactive workspace for claude-code, so its trust
    // dialog opens first; the proof answers it through the native terminal as a user would.
    async answerWorkspaceTrust() {
      if (workspaceTrustAnswered || !/Yes,\s*I\s*trust\s*this\s*folder/u.test(this.screen)) return
      workspaceTrustAnswered = true
      this.write('\u001b[B')
      await sleep(SUBMIT_PAUSE_MS)
      this.write('\r')
    },
    // Braid's composer footer is on screen whatever the profile is named.
    waitForComposer(timeoutMs) {
      return waitForValue(
        'packed Braid TUI startup',
        () => /type \/ for/iu.test(this.screen),
        timeoutMs,
      )
    },
    waitForReady(timeoutMs, afterRevision, beforeScreen) {
      return waitForHarnessTerminalReady({
        tracker: outputTracker,
        readScreen: () => terminalText(terminal),
        screenState,
        timeoutMs,
        afterRevision,
        beforeScreen,
        pause: sleep,
      })
    },
    write(value) {
      record('i', value)
      child.write(value)
    },
    // Enter arrives on its own, so a harness composer does not read it as part of a paste.
    async submit(value) {
      this.write(value)
      await sleep(SUBMIT_PAUSE_MS)
      this.write('\r')
    },
    resize(columns, rows) {
      assert.ok(Number.isInteger(columns) && columns > 0, 'PTY columns must be positive')
      assert.ok(Number.isInteger(rows) && rows > 0, 'PTY rows must be positive')
      child.resize(columns, rows)
      terminal.resize(columns, rows)
    },
    async close() {
      if (exited) return { ...exitResult, processCleanup: await waitForProcessCleanup() }
      child.write('\u0003')
      await waitForValue(
        'Braid terminal quit prompt',
        () => /Ctrl\+C again to quit/iu.test(this.screen),
        exitTimeoutMs,
      )
      child.write('\u0003')
      const result = await waitForValue(
        'Braid terminal exit',
        () => exited && exitResult,
        exitTimeoutMs,
      )
      return { ...result, processCleanup: await waitForProcessCleanup() }
    },
    async forceClose() {
      if (exited) return { ...exitResult, processCleanup: await waitForProcessCleanup() }
      const termTimeoutMs = Math.min(1_000, exitTimeoutMs)
      const termination = await terminateTrackedProcessTree(child, {
        termTimeoutMs,
        killTimeoutMs: Math.max(0, exitTimeoutMs - termTimeoutMs),
      })
      processCleanup = termination.tree
      if (!termination.descendantsVerified) {
        throw new Error(
          `forced Braid terminal cleanup did not remove the tracked process tree (${termination.cleanupStatus})`,
        )
      }
      return { ...exitResult, processCleanup, termination }
    },
    dispose() {
      terminal.dispose()
    },
  }
}

/** Keeps the recording on failure too, and withholds it if it ever carries the Sandbox key. */
export async function writeRecording(runtime, castPath, credential, proofError) {
  const cast = runtime.cast('Braid LIVE-08')
  if (cast.includes(credential))
    return proofError ?? new Error('LIVE-08 terminal recording contained the Sandbox credential')
  // A failed write must not skip the cleanup that follows.
  return writeFile(castPath, cast, { mode: 0o600 }).then(
    () => proofError,
    (error) => proofError ?? error,
  )
}

export function occurrences(value, marker) {
  if (!marker) return 0
  let count = 0
  let offset = 0
  while (offset >= 0) {
    offset = value.indexOf(marker, offset)
    if (offset < 0) break
    count += 1
    offset += marker.length
  }
  return count
}
