import type { WorkspaceRequest } from '@tangle-network/agent-interface'
import { sanitizeTerminalText } from '../shared/sanitize.js'

export function workspaceRequestSummary(
  workspace: Readonly<WorkspaceRequest> | undefined,
): readonly string[] {
  if (workspace === undefined) return []
  const values = [
    workspace.environment === undefined ? undefined : `environment ${workspace.environment}`,
    workspace.image === undefined ? undefined : `image ${workspace.image}`,
    workspace.repoUrl === undefined ? undefined : `repo ${workspace.repoUrl}`,
    workspace.gitRef === undefined ? undefined : `ref ${workspace.gitRef}`,
    workspace.cwd === undefined ? undefined : workspaceCwdLabel(workspace.cwd),
  ].filter((value): value is string => value !== undefined)
  return values.length === 0
    ? ['cloud workspace: provider defaults']
    : [`cloud workspace · ${values.join(' · ')}`]
}

export function compactWorkspaceRequestSummary(
  workspace: Readonly<WorkspaceRequest> | undefined,
): readonly string[] {
  if (workspace === undefined) return []
  const values = [
    workspace.environment === undefined ? undefined : `env ${workspace.environment}`,
    workspace.image === undefined ? undefined : `image ${workspace.image}`,
    workspace.repoUrl === undefined ? undefined : `repo ${workspace.repoUrl}`,
    workspace.gitRef === undefined ? undefined : `ref ${workspace.gitRef}`,
    workspace.cwd === undefined ? undefined : workspaceCwdLabel(workspace.cwd),
  ].filter((value): value is string => value !== undefined)
  return [
    `cloud: ${values.length > 0 ? values.map((value) => shortValue(value, 18)).join(' · ') : 'defaults'}`,
  ]
}

function shortValue(value: string, limit: number): string {
  const sanitized = sanitizeTerminalText(value)
  if (sanitized.length <= limit) return sanitized
  return `${sanitized.slice(0, Math.max(1, limit - 4))}…${sanitized.slice(-3)}`
}

function workspaceCwdLabel(cwd: NonNullable<WorkspaceRequest['cwd']>): string {
  return cwd.base === 'repository' ? `start in repo ${cwd.path}` : `start in host ${cwd.path}`
}
