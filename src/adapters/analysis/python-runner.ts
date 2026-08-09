import { spawn } from 'node:child_process'

const PACKAGE_PROBE = [
  'import importlib.util',
  "required = ('agent_eval_rpc.dspy_rlm_bridge', 'dspy')",
  'missing = []',
  'for name in required:',
  '    try:',
  '        if importlib.util.find_spec(name) is None:',
  '            missing.append(name)',
  '    except (ImportError, ModuleNotFoundError):',
  '        missing.append(name)',
  'if missing:',
  '    raise SystemExit(13)',
].join('\n')

const PACKAGE_MISSING_EXIT_CODE = 13
const DEFAULT_PROBE_TIMEOUT_MS = 2_000

export interface PythonRunnerSpec {
  readonly command: string
  readonly args?: readonly string[]
}

export interface PythonRunnerIdentity extends PythonRunnerSpec {
  readonly source: 'explicit' | 'detected'
}

export type PythonCommandProbeStatus = 'ok' | 'not-found' | 'failed' | 'timed-out'

export interface PythonCommandProbeResult {
  readonly status: PythonCommandProbeStatus
  readonly exitCode?: number
}

export type PythonCommandProbe = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<PythonCommandProbeResult>

export interface ResolvePythonRunnerOptions {
  /** An explicit executable is preferred and is passed as an argv entry point. */
  readonly runner?: PythonRunnerSpec
  /** Detected candidates are executable names, never shell command strings. */
  readonly candidates?: readonly string[]
  readonly probe?: PythonCommandProbe
  readonly timeoutMs?: number
}

export type PythonRunnerResolution =
  | {
      readonly status: 'ready'
      readonly runner: PythonRunnerIdentity
    }
  | {
      readonly status: 'missing-python'
      readonly message: string
    }
  | {
      readonly status: 'missing-python-package'
      readonly runner: PythonRunnerIdentity
      readonly message: string
    }
  | {
      readonly status: 'python-probe-failed'
      readonly runner: PythonRunnerIdentity
      readonly message: string
    }

function defaultCandidates(): readonly string[] {
  const configured = process.env.BRAID_PYTHON?.trim()
  return [...new Set([configured, 'python3', 'python'].filter((value): value is string => !!value))]
}

function normalizedRunner(
  runner: PythonRunnerSpec,
  source: PythonRunnerIdentity['source'],
): PythonRunnerIdentity | undefined {
  const command = runner.command.trim()
  if (command.length === 0) return undefined
  return {
    command,
    source,
    ...(runner.args === undefined ? {} : { args: [...runner.args] }),
  }
}

async function defaultProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<PythonCommandProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(command, [...args], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ status: 'timed-out' })
    }, timeoutMs)

    const finish = (result: PythonCommandProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({ status: error.code === 'ENOENT' ? 'not-found' : 'failed' })
    })
    child.once('exit', (exitCode) => {
      finish(
        exitCode === 0
          ? { status: 'ok', exitCode: 0 }
          : { status: 'failed', exitCode: exitCode ?? -1 },
      )
    })
  })
}

async function probeRunner(
  runner: PythonRunnerIdentity,
  probe: PythonCommandProbe,
  timeoutMs: number,
): Promise<PythonRunnerResolution> {
  const prefix = runner.args ?? []
  const version = await probe(runner.command, [...prefix, '--version'], timeoutMs)
  if (version.status !== 'ok') {
    if (version.status === 'not-found') {
      return {
        status: 'missing-python',
        message: 'The configured Python executable was not found.',
      }
    }
    return {
      status: 'python-probe-failed',
      runner,
      message: 'The configured Python executable could not be started for readiness checks.',
    }
  }

  const packageCheck = await probe(runner.command, [...prefix, '-c', PACKAGE_PROBE], timeoutMs)
  if (packageCheck.status === 'ok') return { status: 'ready', runner }
  if (packageCheck.exitCode === PACKAGE_MISSING_EXIT_CODE) {
    return {
      status: 'missing-python-package',
      runner,
      message:
        'The selected Python executable is available, but agent-eval-rpc[dspy] is not installed.',
    }
  }
  return {
    status: 'python-probe-failed',
    runner,
    message: 'The selected Python executable could not import the trace-analysis packages.',
  }
}

/** Resolve and verify a Python executable without invoking a shell. */
export async function resolvePythonRunner(
  options: ResolvePythonRunnerOptions = {},
): Promise<PythonRunnerResolution> {
  const probe = options.probe ?? defaultProbe
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Python readiness probe timeout must be a positive safe integer')
  }

  if (options.runner !== undefined) {
    const runner = normalizedRunner(options.runner, 'explicit')
    if (runner === undefined) {
      return {
        status: 'python-probe-failed',
        runner: { command: '', source: 'explicit' },
        message: 'The explicit Python executable is empty.',
      }
    }
    return probeRunner(runner, probe, timeoutMs)
  }

  let packageMissing: PythonRunnerResolution | undefined
  let probeFailed: PythonRunnerResolution | undefined
  for (const candidate of options.candidates ?? defaultCandidates()) {
    const runner = normalizedRunner({ command: candidate }, 'detected')
    if (runner === undefined) continue
    const result = await probeRunner(runner, probe, timeoutMs)
    if (result.status === 'ready') return result
    if (result.status === 'missing-python-package') {
      packageMissing ??= result
      continue
    }
    if (result.status === 'python-probe-failed') {
      probeFailed ??= result
    }
  }

  if (packageMissing !== undefined) return packageMissing
  if (probeFailed !== undefined) return probeFailed
  return {
    status: 'missing-python',
    message: 'No usable Python executable was found. Set BRAID_PYTHON or install python3.',
  }
}

export const TRACE_ANALYSIS_PYTHON_PACKAGE_PROBE = PACKAGE_PROBE
