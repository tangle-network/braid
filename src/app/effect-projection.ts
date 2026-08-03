import { canonicalDigest } from '../domain/canonical.js'
import type { EffectRecord as DomainEffectRecord, OperationKind } from '../domain/entities.js'
import { createEffectId, type Digest, parseOperationId } from '../domain/ids.js'
import type { EffectRecord as StoredEffectRecord } from '../ports/effect-storage.js'

const EFFECT_OPERATION_KINDS: Readonly<Record<string, OperationKind>> = {
  'run.execute': 'send',
}

/**
 * Projects a durable effect-storage record into the journal's effect entity.
 *
 * Storage holds the record that guards external dispatch; the journal holds the
 * user-visible operation history. Both describe the same attempt, so the
 * projection carries digests rather than the request itself.
 */
export function projectEffectRecord(record: StoredEffectRecord): DomainEffectRecord {
  const outcomeDigest =
    record.detail === undefined && record.externalReference === undefined
      ? undefined
      : canonicalDigest({
          status: record.status,
          detail: record.detail ?? null,
          externalReference: record.externalReference ?? null,
        })
  return {
    id: createEffectId(`effect-${record.operationId}-${record.requestDigest.slice(0, 24)}`),
    operationId: parseOperationId(record.operationId),
    effectKind: record.effectKind,
    requestDigest: record.requestDigest as Digest,
    kind: EFFECT_OPERATION_KINDS[record.effectKind] ?? 'custom',
    status: record.status,
    attempt: record.attempt,
    ...(outcomeDigest === undefined ? {} : { outcomeDigest }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
