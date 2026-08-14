import { agentInterfaceModuleUrl } from './module-url.js'

type AgentInterfaceModule = typeof import('@tangle-network/agent-interface')

const [capabilities, harness, profile] = (await Promise.all([
  import(agentInterfaceModuleUrl('harness-capabilities.js')),
  import(agentInterfaceModuleUrl('harness.js')),
  import(agentInterfaceModuleUrl('profile-schema.js')),
])) as [
  Pick<
    AgentInterfaceModule,
    | 'harnessHonorsEffort'
    | 'harnessHonorsModel'
    | 'harnessHonorsSelectors'
    | 'harnessReasoningEfforts'
    | 'harnessSupportsModel'
    | 'preferredHarnessForModel'
    | 'reasoningEffortsFor'
    | 'snapHarnessToModel'
    | 'snapModelToHarness'
  >,
  Pick<AgentInterfaceModule, 'harnessTypeSchema'>,
  Pick<AgentInterfaceModule, 'reasoningEffortSchema'>,
]

export const {
  harnessHonorsEffort,
  harnessHonorsModel,
  harnessHonorsSelectors,
  harnessReasoningEfforts,
  harnessSupportsModel,
  preferredHarnessForModel,
  reasoningEffortsFor,
  snapHarnessToModel,
  snapModelToHarness,
} = capabilities
export const harnessTypeSchema: AgentInterfaceModule['harnessTypeSchema'] =
  harness.harnessTypeSchema
export const reasoningEffortSchema: AgentInterfaceModule['reasoningEffortSchema'] =
  profile.reasoningEffortSchema
