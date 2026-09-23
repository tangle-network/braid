import type {
  AnalysisSourceBinding,
  AnalysisSourceRecord,
  FrozenAnalysisSourceHandle,
  MutableAnalysisSourcePort,
  SourceReplayVerification,
  SourceVerification,
} from './source.js'
import { sourceDigest } from './source.js'
import { boundedCloneAndFreeze } from './bounded-copy.js'
import { validateSourceRecord } from './source.js'
import { snapshotTraceStore } from './trace-snapshot.js'

function immutableSource(
  source: AnalysisSourceRecord,
  digest: string,
): AnalysisSourceRecord & { readonly digest: string } {
  return boundedCloneAndFreeze({ ...source, digest })
}

/**
 * Holds the registered durable bindings for analysable sources and enforces the
 * same-revision freeze protocol. Adapters supply the bindings; this port never
 * reads a store itself outside a capture.
 */
export class InMemoryAnalysisSourcePort implements MutableAnalysisSourcePort {
  private readonly sources = new Map<string, AnalysisSourceBinding>()

  constructor(initial: readonly AnalysisSourceBinding[] = []) {
    for (const binding of initial) this.replace(binding)
  }

  replace(binding: AnalysisSourceBinding): void {
    this.sources.set(binding.source.sourceId, binding)
  }

  has(sourceId: string): boolean {
    return this.sources.has(sourceId)
  }

  async freeze(sourceId: string, signal?: AbortSignal): Promise<FrozenAnalysisSourceHandle> {
    if (signal?.aborted) throw new DOMException('Source freeze cancelled', 'AbortError')
    const binding = this.sources.get(sourceId)
    if (!binding) throw new Error(`Analysis source not found: ${sourceId}`)
    const beforeRevision = await binding.currentRevision(signal)
    const captured = await binding.captureAtRevision(signal)
    const source = boundedCloneAndFreeze(captured.source) as AnalysisSourceRecord
    validateSourceRecord(source)
    if (source.sourceRevision !== beforeRevision) {
      throw new Error('Analysis source changed before its revision was captured')
    }
    const traceStore = await snapshotTraceStore(captured.traceStore, source.traceReferences, signal)
    const digest = await sourceDigest(source, traceStore, signal)
    const current = this.sources.get(sourceId)
    const afterRevision = await binding.currentRevision(signal)
    if (
      current !== binding ||
      afterRevision !== beforeRevision ||
      afterRevision !== source.sourceRevision
    ) {
      throw new Error('Analysis source changed while its revision was being frozen')
    }
    return {
      source: immutableSource(source, digest),
      traceStore,
    }
  }

  async verify(handle: FrozenAnalysisSourceHandle): Promise<SourceVerification> {
    const current = this.sources.get(handle.source.sourceId)
    if (!current) throw new Error(`Analysis source not found: ${handle.source.sourceId}`)
    const beforeRevision = await current.currentRevision()
    const captured = await current.captureAtRevision()
    validateSourceRecord(captured.source)
    const currentDigest = await sourceDigest(captured.source, captured.traceStore)
    const afterRevision = await current.currentRevision()
    return {
      unchanged:
        this.sources.get(handle.source.sourceId) === current &&
        beforeRevision === afterRevision &&
        captured.source.sourceRevision === beforeRevision &&
        captured.source.sourceRevision === handle.source.sourceRevision &&
        currentDigest === handle.source.digest,
      currentDigest,
      currentRevision: afterRevision,
    }
  }

  async currentDigest(sourceId: string): Promise<string> {
    const binding = this.sources.get(sourceId)
    if (!binding) throw new Error(`Analysis source not found: ${sourceId}`)
    return (await this.freeze(sourceId)).source.digest
  }

  async replay(handle: FrozenAnalysisSourceHandle): Promise<SourceReplayVerification> {
    const binding = this.sources.get(handle.source.sourceId)
    if (!binding) throw new Error(`Analysis source not found: ${handle.source.sourceId}`)
    const beforeRevision = await binding.currentRevision()
    const captured = await binding.captureAtRevision()
    validateSourceRecord(captured.source)
    const afterRevision = await binding.currentRevision()
    const missingEventIds = [...(captured.source.missingEventIds ?? [])]
    const eventIds = [...captured.source.eventIds]
    const expectedEventIds = [...handle.source.eventIds]
    return {
      complete:
        captured.source.complete &&
        missingEventIds.length === 0 &&
        beforeRevision === afterRevision &&
        captured.source.sourceRevision === handle.source.sourceRevision &&
        eventIds.length === expectedEventIds.length &&
        eventIds.every((eventId, index) => eventId === expectedEventIds[index]),
      sourceRevision: captured.source.sourceRevision,
      eventIds,
      missingEventIds,
    }
  }
}
