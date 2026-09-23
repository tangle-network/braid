import { canonicalDigest } from '../domain/canonical.js'

export function analysisIdForOperation(operationId: string): string {
  return `analysis-${canonicalDigest({ operationId }).slice(0, 48)}`
}

export function receiptIdForOperation(operationId: string, targetId: string): string {
  return `receipt-${canonicalDigest({ operationId, targetId }).slice(0, 48)}`
}
