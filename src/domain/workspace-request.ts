import { type WorkspaceRequest, WorkspaceRequestSchema } from '@tangle-network/agent-interface'
import { canonicalDigest } from './canonical.js'
import { assertPublicUrl } from './invariants-base.js'

export type { WorkspaceRequest }

/** Validate and snapshot the shared workspace request. */
export function snapshotWorkspaceRequest(
  request: WorkspaceRequest | undefined,
): Readonly<WorkspaceRequest> | undefined {
  if (request === undefined) return undefined
  const parsed = WorkspaceRequestSchema.parse(structuredClone(request))
  if (parsed.providerOptions !== undefined && Object.keys(parsed.providerOptions).length > 0) {
    throw new Error(
      'Workspace providerOptions are not persisted; use a provider credential reference',
    )
  }
  if (
    parsed.environment === undefined &&
    parsed.image === undefined &&
    parsed.repoUrl === undefined &&
    parsed.gitRef === undefined &&
    parsed.cwd === undefined
  )
    return undefined
  if (parsed.repoUrl !== undefined) {
    assertPublicUrl(parsed.repoUrl, 'Workspace repoUrl', {
      rejectQuery: true,
      rejectFragment: true,
    })
  }
  const snapshot: WorkspaceRequest = {
    ...(parsed.environment === undefined ? {} : { environment: parsed.environment }),
    ...(parsed.image === undefined ? {} : { image: parsed.image }),
    ...(parsed.repoUrl === undefined ? {} : { repoUrl: parsed.repoUrl }),
    ...(parsed.gitRef === undefined ? {} : { gitRef: parsed.gitRef }),
    ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
  }
  return freezeDeep(snapshot)
}

/** Return the exact canonical identity of a workspace request. */
export function workspaceRequestDigest(request: WorkspaceRequest | undefined): string | undefined {
  const snapshot = snapshotWorkspaceRequest(request)
  return snapshot === undefined ? undefined : canonicalDigest(snapshot)
}

/** Return one bounded validation message without echoing untrusted input. */
export function workspaceRequestErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (
    /Workspace cwd (?:must be relative|must use POSIX separators|cannot leave the workspace root|cannot contain control characters)/iu.test(
      message,
    )
  )
    return 'start in must be a repository-relative path'
  if (/gitRef requires repoUrl/iu.test(message)) return 'gitRef requires repoUrl'
  if (
    /Workspace repoUrl must use HTTPS|Workspace repoUrl must use an allowed URL protocol/iu.test(
      message,
    )
  )
    return 'repoUrl must use HTTPS'
  if (
    /Workspace repoUrl (?:must not contain credentials|cannot contain credential material|cannot contain URL credentials|cannot contain credential-bearing query parameters)/iu.test(
      message,
    )
  ) {
    return 'repoUrl must not contain credentials'
  }
  if (/Workspace repoUrl must not contain query data/iu.test(message)) {
    return 'repoUrl must not contain query data'
  }
  if (/Workspace repoUrl must not contain fragment data/iu.test(message)) {
    return 'repoUrl must not contain fragment data'
  }
  if (/Workspace repoUrl must use a public hostname/iu.test(message)) {
    return 'repoUrl must use a public hostname'
  }
  if (/providerOptions are not persisted/iu.test(message)) {
    return 'providerOptions are not persisted'
  }
  if (/must be a valid URL|Invalid URL/iu.test(message)) return 'repoUrl must be a valid URL'
  return 'workspace request invalid'
}

/** Display only the non-secret origin and path of a repository URL. */
export function compactWorkspaceRepositoryUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return undefined
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}
