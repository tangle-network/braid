import { agentInterfaceModuleUrl } from './module-url.js'

type AgentInterfaceModule = typeof import('@tangle-network/agent-interface')

const [capabilities, harness] = (await Promise.all([
  import(agentInterfaceModuleUrl('harness-capabilities.js')),
  import(agentInterfaceModuleUrl('harness.js')),
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
