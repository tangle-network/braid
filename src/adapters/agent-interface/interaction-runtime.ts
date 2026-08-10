import { agentInterfaceModuleUrl } from './module-url.js'

type AgentInterfaceModule = typeof import('@tangle-network/agent-interface')

const [envelope, permissions, responseValidation] = (await Promise.all([
  import(agentInterfaceModuleUrl('interaction-envelope.js')),
  import(agentInterfaceModuleUrl('interaction-permissions.js')),
  import(agentInterfaceModuleUrl('interaction-response-validation.js')),
])) as [
  Pick<
    AgentInterfaceModule,
    | 'InteractionRequestSchema'
    | 'InteractionResponseCommandSchema'
    | 'InteractionResponseSchema'
    | 'interactionRequestDigest'
    | 'interactionResponseCommandDigest'
  >,
  Pick<AgentInterfaceModule, 'permissionAnswerSpec'>,
  Pick<AgentInterfaceModule, 'validateInteractionResponse'>,
]

export const InteractionRequestSchema: AgentInterfaceModule['InteractionRequestSchema'] =
  envelope.InteractionRequestSchema
export const InteractionResponseCommandSchema: AgentInterfaceModule['InteractionResponseCommandSchema'] =
  envelope.InteractionResponseCommandSchema
export const InteractionResponseSchema: AgentInterfaceModule['InteractionResponseSchema'] =
  envelope.InteractionResponseSchema
export const { interactionRequestDigest, interactionResponseCommandDigest } = envelope
export const { permissionAnswerSpec } = permissions
export const { validateInteractionResponse } = responseValidation
