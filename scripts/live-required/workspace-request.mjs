const DEFAULT_REPOSITORY = 'https://github.com/tangle-network/braid.git'
const DEFAULT_GIT_REF = 'main'

// WorkspaceRequest.cwd is portable and resolves from the provider repository root.
// Keep validation in agent-interface so every caller shares one contract.
export const DEFAULT_WORKSPACE_CWD = '.'

export function workspaceRequestFor(environment = {}) {
  return {
    repoUrl: environment.BRAID_TANGLE_SANDBOX_REPOSITORY ?? DEFAULT_REPOSITORY,
    gitRef: environment.BRAID_TANGLE_SANDBOX_GIT_REF ?? DEFAULT_GIT_REF,
    cwd: environment.BRAID_TANGLE_SANDBOX_CWD?.trim() || DEFAULT_WORKSPACE_CWD,
  }
}
