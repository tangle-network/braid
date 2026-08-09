import { posix, win32 } from 'node:path'

function assertArguments(args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string'))
    throw new Error('Package-manager arguments must be strings')
}

/** Returns an argv that never asks Windows to execute a non-executable .cmd shim. */
export function npmInvocation(
  args,
  { platform = process.platform, execPath = process.execPath } = {},
) {
  assertArguments(args)
  if (platform !== 'win32') return { file: 'npm', args: [...args] }
  const path = platform === 'win32' ? win32 : posix
  return {
    file: execPath,
    args: [path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args],
  }
}

/** Uses the active pnpm JavaScript entry point on Windows instead of its .cmd shim. */
export function pnpmInvocation(
  args,
  { platform = process.platform, execPath = process.execPath, environment = process.env } = {},
) {
  assertArguments(args)
  if (platform !== 'win32') return { file: 'pnpm', args: [...args] }
  const entry = environment.npm_execpath
  if (typeof entry !== 'string' || !/(?:^|[\\/])pnpm(?:\.[cm]?js)?$/iu.test(entry))
    throw new Error('Windows pnpm invocation requires the active pnpm JavaScript entry point')
  return { file: execPath, args: [entry, ...args] }
}

export function portableEvidencePath(path) {
  return String(path).replaceAll('\\', '/')
}
