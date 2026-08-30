/**
 * Track terminal output until the renderer has caught up and its animated
 * status indicators have stopped producing frames.
 *
 * Pi's public Loader uses an 80ms default frame interval in 0.80.2, 0.82.1,
 * and 0.84.4. Three complete intervals provide a renderer-observable quiet
 * period that cannot occur while that indicator is still animating.
 */
export const PI_LOADER_INTERVAL_MS = 80
export const TERMINAL_QUIET_INTERVAL_MS = PI_LOADER_INTERVAL_MS * 3
export const TERMINAL_QUIET_POLL_INTERVAL_MS = 25

const PI_EDITOR_RULE_PATTERN = /^─{8,}$/u
const PI_FOOTER_PATH_PATTERN = /^(?:~|\/)[^\n]*$/u
const PI_WORKING_STATUS_PATTERN =
  /\b(?:Working(?:\.\.\.|…)|Retrying\b|Compacting\b|Summarizing branch\b)/iu
const PI_SPINNER_PATTERN = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/u
const TERMINAL_ESCAPE = String.fromCharCode(27)
const TERMINAL_BELL = String.fromCharCode(7)
const OSC_TERMINAL_SEQUENCE = new RegExp(
  `${TERMINAL_ESCAPE}\\][^${TERMINAL_BELL}]*(?:${TERMINAL_BELL}|${TERMINAL_ESCAPE}\\\\)`,
  'gu',
)
const CSI_TERMINAL_SEQUENCE = new RegExp(`${TERMINAL_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'gu')
const CHARSET_TERMINAL_SEQUENCE = new RegExp(`${TERMINAL_ESCAPE}\\([0-2A-Za-z]`, 'gu')

function stripTerminalSequences(value) {
  return value
    .replace(OSC_TERMINAL_SEQUENCE, '')
    .replace(CSI_TERMINAL_SEQUENCE, '')
    .replace(CHARSET_TERMINAL_SEQUENCE, '')
}

function screenRows(screen) {
  if (typeof screen !== 'string') throw new TypeError('Pi terminal screen must be a string')
  return stripTerminalSequences(screen)
    .split(/\r?\n/u)
    .map((line) => line.replace(/[ \t]+$/u, ''))
}

function piEditorRule(line) {
  return PI_EDITOR_RULE_PATTERN.test(line.trim())
}

function piComposerBounds(rows) {
  const rules = []
  for (let index = 0; index < rows.length; index += 1) {
    if (piEditorRule(rows[index] ?? '')) rules.push(index)
  }
  for (let index = rules.length - 2; index >= 0; index -= 1) {
    const top = rules[index]
    const bottom = rules[index + 1]
    if (top === undefined || bottom === undefined || bottom <= top + 1) continue
    const trailingRows = rows.slice(bottom + 1).filter((line) => line.trim().length > 0)
    if (trailingRows.length > 3) continue
    const footerPath = trailingRows.findIndex((line) => PI_FOOTER_PATH_PATTERN.test(line.trim()))
    if (footerPath >= 0) return { top, bottom, footer: bottom + 1 + footerPath }
  }
  return undefined
}

function piStatusRows(rows, top) {
  const start = Math.max(0, top - 8)
  return rows
    .slice(start, top)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function normalizedScreen(screen) {
  return screenRows(screen).join('\n').trim()
}

/**
 * Classify the visible state of Pi's interactive terminal.
 *
 * Pi 0.84.4 renders a `Working...` status indicator above its editor.
 * Its ready composer has two horizontal editor rules and a cwd footer row.
 * These are public rendered behaviors, so this check does not inspect Pi's
 * private session state or guess from elapsed time.
 */
export function piTerminalScreenState(screen) {
  const rows = screenRows(screen)
  const composer = piComposerBounds(rows)
  if (composer === undefined) return { state: 'unknown', reason: 'composer-not-visible' }
  const status = piStatusRows(rows, composer.top)
  const working = status.find(
    (line) => PI_WORKING_STATUS_PATTERN.test(line) || PI_SPINNER_PATTERN.test(line),
  )
  if (working !== undefined) {
    return { state: 'working', composer, status: working }
  }
  return { state: 'ready', composer }
}

/**
 * Wait until Pi has rendered a ready composer after an action.
 *
 * A quiet renderer is necessary but insufficient: a static `Working...` line
 * can remain after its spinner stops, and a stale ready screen can precede a
 * delayed remote render. The optional baseline requires a visible transition
 * before readiness is accepted.
 */
export async function waitForPiTerminalReady({
  tracker,
  readScreen,
  timeoutMs,
  afterRevision,
  beforeScreen,
  now = () => performance.now(),
  pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (
    !tracker ||
    typeof tracker.isQuiescent !== 'function' ||
    typeof tracker.snapshot !== 'function'
  ) {
    throw new TypeError('terminal output tracker is required')
  }
  if (typeof readScreen !== 'function') throw new TypeError('Pi terminal screen reader is required')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Pi terminal readiness timeout must be positive')
  }
  if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) {
    throw new RangeError('terminal output revision must be a non-negative safe integer')
  }

  const baseline = beforeScreen === undefined ? undefined : normalizedScreen(beforeScreen)
  const deadline = now() + timeoutMs
  let sawWorking = false
  let sawScreenChange = false
  let lastState = { state: 'unknown', reason: 'not-observed' }
  for (;;) {
    const screen = readScreen()
    const state = piTerminalScreenState(screen)
    lastState = state
    if (state.state === 'working') sawWorking = true
    if (baseline !== undefined && normalizedScreen(screen) !== baseline) sawScreenChange = true
    const snapshot = tracker.snapshot()
    const observedAfterAction = afterRevision === undefined || snapshot.revision > afterRevision
    const transitioned =
      baseline === undefined || sawWorking || sawScreenChange || state.state === 'working'
    if (observedAfterAction && tracker.isQuiescent() && state.state === 'ready' && transitioned) {
      return { ...snapshot, readiness: state, transitioned }
    }
    if (now() >= deadline) {
      throw new Error(
        `Pi terminal did not become ready after ${timeoutMs}ms: ${JSON.stringify({
          ...snapshot,
          state: lastState.state,
          reason: lastState.reason,
          observedAfterAction,
          sawWorking,
          sawScreenChange,
        })}`,
      )
    }
    await pause(Math.min(TERMINAL_QUIET_POLL_INTERVAL_MS, Math.max(0, deadline - now())))
  }
}

export function createTerminalOutputTracker({
  now = () => performance.now(),
  quietIntervalMs = TERMINAL_QUIET_INTERVAL_MS,
} = {}) {
  if (!Number.isFinite(quietIntervalMs) || quietIntervalMs <= 0) {
    throw new RangeError('terminal quiet interval must be positive')
  }

  let pendingWrites = 0
  let lastOutputAt = now()
  let revision = 0

  const observe = (data, write) => {
    if (typeof data !== 'string' || data.length === 0) {
      throw new TypeError('terminal output must be a non-empty string')
    }
    if (typeof write !== 'function') throw new TypeError('terminal output writer is required')

    lastOutputAt = now()
    revision += 1
    pendingWrites += 1
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      pendingWrites -= 1
    }
    try {
      write(settle)
    } catch (error) {
      settle()
      throw error
    }
  }

  const snapshot = () => ({
    pendingWrites,
    lastOutputAt,
    revision,
    quietForMs: Math.max(0, now() - lastOutputAt),
    quietIntervalMs,
  })

  return {
    observe,
    isQuiescent: () => pendingWrites === 0 && now() - lastOutputAt >= quietIntervalMs,
    snapshot,
  }
}

export async function waitForTerminalQuiescence(
  tracker,
  {
    timeoutMs,
    afterRevision,
    now = () => performance.now(),
    pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (
    !tracker ||
    typeof tracker.isQuiescent !== 'function' ||
    typeof tracker.snapshot !== 'function'
  ) {
    throw new TypeError('terminal output tracker is required')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('terminal quiescence timeout must be positive')
  }
  if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) {
    throw new RangeError('terminal output revision must be a non-negative safe integer')
  }

  const deadline = now() + timeoutMs
  for (;;) {
    const snapshot = tracker.snapshot()
    const observedAfterAction = afterRevision === undefined || snapshot.revision > afterRevision
    if (observedAfterAction && tracker.isQuiescent()) return snapshot
    if (now() >= deadline) {
      throw new Error(
        `terminal output did not become quiescent after ${timeoutMs}ms: ${JSON.stringify(snapshot)}`,
      )
    }
    await pause(Math.min(TERMINAL_QUIET_POLL_INTERVAL_MS, Math.max(0, deadline - now())))
  }
}
