import { createRequire } from 'node:module'

const AGENT_EVAL_RPC_VERSION = '0.144.11'
const PYTHON_VERSION = '3.12'
const RESOLUTION_CUTOFF = '2026-08-11T05:00:00Z'
const RUNTIME_PROBE = [
  'import importlib.metadata',
  'import sys',
  'import agent_eval_rpc.dspy_rlm_bridge',
  'import dspy',
  `assert sys.version_info[:2] == (${PYTHON_VERSION.replace('.', ', ')})`,
  `assert importlib.metadata.version("agent-eval-rpc") == "${AGENT_EVAL_RPC_VERSION}"`,
].join('\n')

const SUPPORTED_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-ia32',
  'win32-x64',
])

type PackageResolver = (specifier: string) => string

export interface ManagedAnalysisRuntimeOptions {
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
  readonly resolvePackage?: PackageResolver
}

export interface ManagedAnalysisRunner {
  readonly command: string
  readonly args: readonly string[]
  readonly launcherProbeArgs: readonly string[]
  readonly runtimeProbeArgs: readonly string[]
}

function environmentArgs(launcher: string): readonly string[] {
  return [
    launcher,
    'run',
    '--no-project',
    '--no-config',
    '--no-env-file',
    '--isolated',
    '--managed-python',
    '--python',
    PYTHON_VERSION,
    '--with',
    `agent-eval-rpc[dspy]==${AGENT_EVAL_RPC_VERSION}`,
    '--exclude-newer',
    RESOLUTION_CUTOFF,
    '--default-index',
    'https://pypi.org/simple',
    '--keyring-provider',
    'disabled',
    '--color',
    'never',
    '--no-progress',
    'python',
  ]
}

/** Resolve the bundled uv binary and its immutable Agent Eval invocation. */
export function managedAnalysisRunner(
  options: ManagedAnalysisRuntimeOptions = {},
): ManagedAnalysisRunner | undefined {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  if (!SUPPORTED_TARGETS.has(`${platform}-${architecture}`)) return undefined

  const resolvePackage = options.resolvePackage ?? createRequire(import.meta.url).resolve
  let launcher: string
  try {
    launcher = resolvePackage('@dataiku/uv/bin.cjs')
  } catch {
    return undefined
  }

  const environment = environmentArgs(launcher)
  return {
    command: process.execPath,
    args: [...environment, '-m', 'agent_eval_rpc.dspy_rlm_bridge'],
    launcherProbeArgs: [launcher, '--version'],
    runtimeProbeArgs: [...environment, '-c', RUNTIME_PROBE],
  }
}

export const MANAGED_AGENT_EVAL_RPC_VERSION = AGENT_EVAL_RPC_VERSION
export const MANAGED_ANALYSIS_PYTHON_VERSION = PYTHON_VERSION
export const MANAGED_ANALYSIS_RUNTIME_PROBE = RUNTIME_PROBE
