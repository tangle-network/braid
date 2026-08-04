import { assertEffectRecordInput } from './storage-validation.js'
import { clone } from './memory-base.js'

import { MemoryRetentionStorage } from './memory-retention.js'

export class MemoryEffectsStorage extends MemoryRetentionStorage {
  reserveEffect(record: import('../../ports/effect-storage.js').EffectRecord): {
    readonly record: import('../../ports/effect-storage.js').EffectRecord
    readonly created: boolean
  } {
    this.assertOpen()
    assertEffectRecordInput(record)
    const current = this.current(record.operationId)
    if (current !== undefined) {
      if (current.requestDigest === record.requestDigest) {
        return { record: current, created: false }
      }
      const conflict: import('../../ports/effect-storage.js').EffectRecord = {
        ...record,
        status: 'conflict',
        detail: `Operation is already bound to request digest ${current.requestDigest}`,
        conflictWithDigest: current.requestDigest,
      }
      this.appendEffect(conflict)
      return { record: clone(conflict), created: false }
    }
    this.appendEffect(record)
    return { record: clone(record), created: true }
  }

  current(operationId: string): import('../../ports/effect-storage.js').EffectRecord | undefined {
    const records = this.effectStore.get(operationId) ?? []
    const record = [...records].reverse().find((candidate) => candidate.status !== 'conflict')
    return record === undefined ? undefined : clone(record)
  }

  latest(
    operationId: string,
    requestDigest: string,
  ): import('../../ports/effect-storage.js').EffectRecord | undefined {
    const records = this.effectStore.get(operationId) ?? []
    const record = [...records]
      .reverse()
      .find((candidate) => candidate.requestDigest === requestDigest)
    return record === undefined ? undefined : clone(record)
  }

  appendEffect(record: import('../../ports/effect-storage.js').EffectRecord): void {
    assertEffectRecordInput(record)
    const records = this.effectStore.get(record.operationId) ?? []
    records.push(clone(record))
    this.effectStore.set(record.operationId, records)
  }

  history(operationId: string): readonly import('../../ports/effect-storage.js').EffectRecord[] {
    return clone(this.effectStore.get(operationId) ?? [])
  }
}
