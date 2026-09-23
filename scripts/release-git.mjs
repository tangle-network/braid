import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { assert } from './release-evidence.mjs'

const EXTERNAL_GIT_VARIABLES = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES_RELATIVE',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
])

function fail(message) {
  throw new Error(message)
}

function inside(root, target) {
  const location = relative(root, target)
  return location !== '..' && !location.startsWith(`..${sep}`) && !location.startsWith(sep)
}

export function assertNoExternalGitOverrides(environment = process.env) {
  for (const name of Object.keys(environment)) {
    if (EXTERNAL_GIT_VARIABLES.has(name) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name))
      fail(`External Git environment override is not allowed: ${name}`)
  }
}

function sanitizedEnvironment() {
  assertNoExternalGitOverrides()
  const environment = { ...process.env }
  for (const name of EXTERNAL_GIT_VARIABLES) delete environment[name]
  for (const name of Object.keys(environment))
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)) delete environment[name]
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  environment.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return environment
}

function resolveGitDirectory(repository) {
  const dotGit = join(repository, '.git')
  const info = lstatSync(dotGit)
  if (info.isDirectory()) return realpathSync(dotGit)
  assert(info.isFile(), 'Git metadata path is not a directory or gitfile')
  const contents = readFileSync(dotGit, 'utf8').trim()
  const match = contents.match(/^gitdir:\s*(.+)$/iu)
  assert(match, 'Git metadata gitfile is malformed')
  return realpathSync(resolve(dirname(dotGit), match[1]))
}

function resolveCommonDirectory(gitDirectory) {
  const commonPath = join(gitDirectory, 'commondir')
  if (!existsSync(commonPath)) return gitDirectory
  const value = readFileSync(commonPath, 'utf8').trim()
  assert(value.length > 0, 'Git common directory file is empty')
  return realpathSync(resolve(gitDirectory, value))
}

export function createGitContext(repository) {
  assertNoExternalGitOverrides()
  const checkout = realpathSync(repository)
  const gitDirectory = resolveGitDirectory(checkout)
  const commonDirectory = resolveCommonDirectory(gitDirectory)
  const objectDirectory = join(commonDirectory, 'objects')
  const alternatePath = join(objectDirectory, 'info', 'alternates')
  if (existsSync(alternatePath)) {
    for (const line of readFileSync(alternatePath, 'utf8').split(/\r?\n/u)) {
      if (line.trim().length === 0) continue
      const alternate = resolve(objectDirectory, line.trim())
      if (!inside(objectDirectory, alternate))
        fail('Git object alternates must remain inside the checkout metadata')
    }
  }
  return Object.freeze({
    repository: checkout,
    gitDirectory,
    commonDirectory,
    objectDirectory,
    environment: sanitizedEnvironment(),
  })
}

function runGit(context, args, trim = true) {
  assertNoExternalGitOverrides()
  const output = execFileSync(
    'git',
    [
      '--no-optional-locks',
      '--git-dir',
      context.gitDirectory,
      '--work-tree',
      context.repository,
      ...args,
    ],
    { cwd: context.repository, encoding: 'utf8', env: context.environment },
  )
  return trim ? output.trim() : output
}

export function git(context, ...args) {
  return runGit(context, args)
}

export function gitNul(context, ...args) {
  return runGit(context, args, false)
}

export function initializeGit(repository, ...args) {
  assertNoExternalGitOverrides()
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd: repository,
    encoding: 'utf8',
    env: sanitizedEnvironment(),
  }).trim()
}

export function assertBoundGitContext(context) {
  assert(realpathSync(git(context, 'rev-parse', '--git-dir')) === context.gitDirectory, 'Git directory binding changed')
  assert(realpathSync(git(context, 'rev-parse', '--git-common-dir')) === context.commonDirectory, 'Git common directory binding changed')
  assert(realpathSync(git(context, 'rev-parse', '--show-toplevel')) === context.repository, 'Git work tree binding changed')
  const index = realpathSync(git(context, 'rev-parse', '--git-path', 'index'))
  assert(index.startsWith(`${context.gitDirectory}${sep}`), 'Git index is outside the bound metadata')
  const objects = realpathSync(git(context, 'rev-parse', '--git-path', 'objects'))
  assert(objects === context.objectDirectory, 'Git object directory binding changed')
}

export function isTracked(context, path) {
  try {
    return git(context, 'ls-files', '--error-unmatch', '--', path) === path
  } catch {
    return false
  }
}

export function assertTracked(context, path) {
  assert(
    typeof path === 'string' &&
      path.length > 0 &&
      path.length <= 4096 &&
      !path.includes('\\') &&
      !path.startsWith('/') &&
      !path.split('/').some((component) => component.length === 0 || component === '.' || component === '..'),
    'Tracked source path is not canonical',
  )
  assert(!path.startsWith('artifacts/verification/'), 'Requirement implementation cannot be an artifact')
  assert(isTracked(context, path), `Requirement implementation is not tracked: ${path}`)
}

export function parseNulPaths(output) {
  return output.split('\0').filter(Boolean)
}
