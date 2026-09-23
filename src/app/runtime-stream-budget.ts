import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import {
  assertBoundedStructure,
  MAX_INTERACTION_FIELDS,
  MAX_PROVIDER_EVENTS,
  MAX_PROVIDER_STREAM_BYTES,
  MAX_RPC_LINE_BYTES,
  MAX_STRUCTURAL_DEPTH,
} from '../domain/bounds.js'

export class RuntimeStreamBudget {
  #events = 0
  #bytes = 0

  accept(event: RuntimeStreamEvent): void {
    this.#events += 1
    if (this.#events > MAX_PROVIDER_EVENTS) {
      throw new Error('Provider stream contains too many events')
    }
    assertBoundedStructure(event, {
      maxBytes: MAX_RPC_LINE_BYTES,
      maxTotalBytes: MAX_PROVIDER_STREAM_BYTES,
      maxDepth: MAX_STRUCTURAL_DEPTH,
      maxArrayLength: MAX_INTERACTION_FIELDS,
      maxObjectKeys: MAX_INTERACTION_FIELDS,
      maxFields: MAX_INTERACTION_FIELDS * 4,
    })
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    this.#bytes += bytes
    if (this.#bytes > MAX_PROVIDER_STREAM_BYTES) {
      throw new Error('Provider stream exceeds the byte limit')
    }
  }
}
