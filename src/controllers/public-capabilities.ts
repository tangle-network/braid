import { canonicalDigest } from '../domain/canonical.js'

export interface PublicCapabilityDigestInput {
  readonly environment: unknown
  readonly supportedRunners: readonly string[]
  readonly modelIds: readonly string[]
  readonly modelReasoning: unknown
  readonly retrievedAt: string
  readonly source: string
}

/** One digest formula for the redacted capability snapshot kept in receipts. */
export function publicCapabilitySnapshotDigest(input: PublicCapabilityDigestInput): string {
  return canonicalDigest({
    kind: 'braid.public-capability-snapshot',
    schemaVersion: 1,
    environment: input.environment,
    supportedRunners: input.supportedRunners,
    modelIds: input.modelIds,
    modelReasoning: input.modelReasoning,
    retrievedAt: input.retrievedAt,
    source: input.source,
  })
}
