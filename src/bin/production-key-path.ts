import { dirname, join, resolve } from 'node:path'
import { resolveHeadlessKeyPath } from '../adapters/credentials/headless-key.js'

export function productionConfigPath(workspace: string, configPath?: string): string {
  return resolve(configPath ?? join(workspace, '.braid', 'config.json'))
}

/**
 * Resolves a database key from the protected Braid config directory.
 * Relative values never use cwd or the agent workspace as their base.
 */
export function resolveProductionDatabaseKeyFile(
  keyFile: string,
  configPath: string,
  workspace: string,
): string {
  return resolveHeadlessKeyPath(keyFile, dirname(resolve(configPath)), resolve(workspace))
}
