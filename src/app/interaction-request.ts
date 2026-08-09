import {
  InteractionRequestSchema,
  interactionRequestDigest,
  type InteractionBinding,
  type InteractionRequest,
  type InteractionRequestBinding,
  type InteractionRequestMaterial,
} from '@tangle-network/agent-interface'

type ParsedInteractionRequest = ReturnType<typeof InteractionRequestSchema.parse>

export function createInteractionRequest(material: InteractionRequestMaterial): InteractionRequest {
  const candidate = {
    ...material,
    requestDigest: interactionRequestDigest(material),
  }
  const parsed = InteractionRequestSchema.safeParse(candidate)
  if (!parsed.success) throw new TypeError('Interaction request material is invalid')
  return exactInteractionRequest(parsed.data)
}

export function parseInteractionRequest(value: unknown): InteractionRequest | undefined {
  const parsed = InteractionRequestSchema.safeParse(value)
  return parsed.success ? exactInteractionRequest(parsed.data) : undefined
}

export function interactionRequestMaterial(
  request: InteractionRequest,
  binding: InteractionRequestBinding = request.binding,
): InteractionRequestMaterial {
  return exactInteractionMaterial(request, binding)
}

export function rebindInteractionRequest(
  request: InteractionRequest,
  binding: InteractionRequestBinding,
): InteractionRequest {
  return createInteractionRequest(interactionRequestMaterial(request, binding))
}

export function interactionResponseBinding(request: InteractionRequest): InteractionBinding {
  return { ...request.binding, requestDigest: request.requestDigest }
}

function exactInteractionRequest(request: ParsedInteractionRequest): InteractionRequest {
  return {
    ...exactInteractionMaterial(request, request.binding),
    requestDigest: request.requestDigest,
  }
}

function exactInteractionMaterial(
  request: ParsedInteractionRequest | InteractionRequest,
  binding: InteractionRequestBinding,
): InteractionRequestMaterial {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.subject === undefined ? {} : { subject: structuredClone(request.subject) }),
    answerSpec: structuredClone(request.answerSpec),
    ...(request.responseScopes === undefined
      ? {}
      : { responseScopes: [...request.responseScopes] }),
    ...(request.allowedOutcomes === undefined
      ? {}
      : { allowedOutcomes: [...request.allowedOutcomes] }),
    ...(request.default === undefined ? {} : { default: structuredClone(request.default) }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.onTimeout === undefined ? {} : { onTimeout: request.onTimeout }),
    binding: { ...binding },
  }
}
