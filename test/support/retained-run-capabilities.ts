import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'

export const RETAINED_RUN_HANDLE_CAPABILITIES: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: false,
    systemPrompt: { replace: false, append: false },
    instructions: false,
    tools: false,
    permissions: false,
    mcp: false,
    subagents: false,
    resources: {
      files: false,
      instructions: false,
      tools: false,
      skills: false,
      agents: false,
      commands: false,
    },
    hooks: false,
    modes: false,
    runtimeUpdate: false,
    validation: false,
  },
  streaming: { live: true, replay: false, detach: false, turnIdempotency: true },
  sessions: { continue: false, list: false, messages: false },
  workspace: { read: false, write: false, exec: false, git: false, upload: false, download: false },
  branching: { checkpoint: false, fork: false },
  placement: false,
  usage: false,
  confidential: true,
}
