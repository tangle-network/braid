import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The platform Braid data directory is independent of the selected workspace. */
export function defaultBraidDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    return join(environment.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'braid')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'braid')
  }
  return join(environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'braid')
}

/** The stable identity shared by durable state and headless credentials. */
export function productionWorkspaceConfigIdentity(workspace: string, configPath: string): string {
  return createHash('sha256')
    .update(`${resolve(workspace)}\u0000${resolve(configPath)}`, 'utf8')
    .digest('hex')
}

/**
 * The default durable database is isolated by canonical workspace/config identity.
 *
 * BRAID_STATE_PATH remains an explicit escape hatch for operators that need to
 * point several processes at a deliberately shared state file.
 */
export function defaultStatePath(
  workspace: string,
  configPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.BRAID_STATE_PATH) return environment.BRAID_STATE_PATH
  const canonicalWorkspace = resolve(workspace)
  const canonicalConfigPath = resolve(
    configPath ?? join(canonicalWorkspace, '.braid', 'config.json'),
  )
  const identity = productionWorkspaceConfigIdentity(canonicalWorkspace, canonicalConfigPath)
  return join(defaultBraidDataDirectory(environment), 'workspaces', identity, 'braid.sqlite')
}
