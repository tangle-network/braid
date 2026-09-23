import type { AgentProfileSecurityPolicy } from '@tangle-network/agent-interface'
import {
  isVerifiedWorkspaceTrust,
  type VerifiedWorkspaceTrust,
} from '../connection/workspace-trust.js'
import { redactErrorMessage } from '../connection/redaction.js'
import type {
  ProfileSourceKind,
  ProfileResolveOptions,
  ProfileSourceRegistry,
  ProfileDocument,
} from './profile-sources.js'

export interface ProfileDiscoveryInput {
  readonly explicitReference?: string
  readonly workspaceTrust?: VerifiedWorkspaceTrust
  readonly workspaceReferences?: readonly string[]
  readonly userReferences?: readonly string[]
  readonly providerReferences?: readonly string[]
  readonly recentReferences?: readonly string[]
  readonly securityPolicy?: AgentProfileSecurityPolicy
  readonly limits?: ProfileResolveOptions['limits']
}

export interface DiscoveredProfile {
  readonly reference: string
  readonly source: ProfileSourceKind
  readonly document?: ProfileDocument
  readonly error?: string
}

function sourceKind(reference: string): ProfileSourceKind {
  if (reference.startsWith('inline:')) return 'inline'
  if (reference.startsWith('configured:')) return 'configured'
  if (reference.startsWith('github:')) return 'github'
  if (reference.startsWith('provider:')) return 'provider-catalog'
  if (reference.startsWith('package:')) return 'provider-catalog'
  return 'local-file'
}

function workspaceReferencesFor(input: ProfileDiscoveryInput): readonly string[] {
  if (!isVerifiedWorkspaceTrust(input.workspaceTrust)) return []
  if (!input.workspaceTrust.record.capabilities.includes('profile-source')) return []
  return input.workspaceReferences ?? []
}

export async function discoverProfiles(
  input: ProfileDiscoveryInput,
  registry: ProfileSourceRegistry,
): Promise<readonly DiscoveredProfile[]> {
  const references =
    input.explicitReference !== undefined
      ? [input.explicitReference]
      : [
          ...workspaceReferencesFor(input),
          ...(input.userReferences ?? []),
          ...(input.providerReferences ?? []),
          ...(input.recentReferences ?? []),
        ]
  const options: ProfileResolveOptions = {
    ...(input.securityPolicy === undefined ? {} : { securityPolicy: input.securityPolicy }),
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  }
  const discovered: DiscoveredProfile[] = []
  for (const reference of [...new Set(references)]) {
    try {
      if (typeof reference !== 'string' || reference.length === 0 || reference.length > 4_096) {
        throw new Error('Profile reference is empty or too long')
      }
      discovered.push(
        Object.freeze({
          reference,
          source: sourceKind(reference),
          document: await registry.resolve(reference, options),
        }),
      )
    } catch (error) {
      const safeReference = typeof reference === 'string' ? reference : '<invalid reference>'
      discovered.push(
        Object.freeze({
          reference: safeReference,
          source: typeof reference === 'string' ? sourceKind(reference) : 'local-file',
          error: redactErrorMessage(error),
        }),
      )
    }
  }
  return Object.freeze(discovered)
}
