import type { RunRecord } from '@tangle-network/agent-eval'
import { canonicalDigest } from '../domain/canonical.js'
import {
  comparePairedSources,
  type ComparisonArmBinding,
  type PairedComparison,
} from '../analysis/comparison.js'
import type { AnalysisSourcePort } from '../analysis/source.js'
import { AppError } from './errors.js'
import { receiptIdForOperation } from './operation-authority.js'
import type { ApplicationReceiptService } from './application-receipts.js'

export interface ApplicationComparison extends PairedComparison {
  readonly receiptId: string
  readonly replayed: boolean
}

export interface ApplicationComparisonHost {
  readonly readAnalysisSource: () => AnalysisSourcePort | undefined
  readonly receipts: ApplicationReceiptService
}

/** Runs paired comparison only after both frozen source bindings are supplied. */
export class ApplicationComparisonService {
  constructor(private readonly host: ApplicationComparisonHost) {}

  async compare(input: {
    readonly operationId: string
    readonly baselineSourceId: string
    readonly treatmentSourceId: string
    readonly baselineRuns: readonly RunRecord[]
    readonly treatmentRuns: readonly RunRecord[]
    readonly baselineBinding: ComparisonArmBinding
    readonly treatmentBinding: ComparisonArmBinding
  }): Promise<ApplicationComparison> {
    const targetId = `comparison:${input.baselineSourceId}:${input.treatmentSourceId}`
    const digest = canonicalDigest({ kind: 'compare', targetId, input })
    const previous = this.host.receipts.read<ApplicationComparison>(input.operationId, digest)
    if (previous) {
      if (previous.pending) return { ...(await previous.pending), replayed: true }
      const result = this.host.receipts.requireResult(
        previous,
        'Comparison result is not available',
      )
      return { ...result, replayed: true }
    }
    const source = this.host.readAnalysisSource()
    if (!source) throw new AppError('CAPABILITY_UNAVAILABLE', 'Comparison is unavailable')
    const pending = comparePairedSources({
      source,
      baselineSourceId: input.baselineSourceId,
      treatmentSourceId: input.treatmentSourceId,
      baselineRuns: input.baselineRuns,
      treatmentRuns: input.treatmentRuns,
      baselineBinding: input.baselineBinding,
      treatmentBinding: input.treatmentBinding,
    }).then(
      (comparison): ApplicationComparison => ({
        ...comparison,
        receiptId: receiptIdForOperation(input.operationId, targetId),
        replayed: false,
      }),
    )
    this.host.receipts.setPending(input.operationId, digest, pending)
    let result: ApplicationComparison
    try {
      result = await pending
    } catch (error) {
      this.host.receipts.deletePending(input.operationId, pending)
      throw error
    }
    this.host.receipts.setResult(input.operationId, digest, result)
    this.host.receipts.publish(input.operationId, targetId, result)
    return result
  }

  async compareSources(input: {
    readonly operationId: string
    readonly baselineSourceId: string
    readonly treatmentSourceId: string
  }): Promise<ApplicationComparison> {
    const source = this.host.readAnalysisSource()
    if (!source) throw new AppError('CAPABILITY_UNAVAILABLE', 'Comparison is unavailable')
    void input
    throw new AppError(
      'CAPABILITY_UNAVAILABLE',
      'Comparison needs explicit frozen run rows and exact arm bindings',
    )
  }
}

/** Compatibility name for existing internal callers; the implementation is a comparison service. */
export { ApplicationComparisonService as ApplicationComparisonController }
