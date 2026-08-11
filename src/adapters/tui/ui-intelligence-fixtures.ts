import type { BraidIntent } from '../../views/shared/intents.js'
import {
  FIXTURE_ANALYSIS_DATA,
  FIXTURE_COMPARISON_RESULT,
  PRODUCT_DEMO_ANALYSIS_DATA,
  type UiFixture,
} from './ui-fixtures.js'

interface IntelligenceFixtureResult {
  readonly data: unknown
  readonly notice: string
}

/** Keeps screenshot-only results behind the explicit --ui-fixture option. */
export function resolveIntelligenceFixture(
  intent: BraidIntent,
  fixture: UiFixture | undefined,
): IntelligenceFixtureResult | undefined {
  if (intent.type !== 'run-command') return undefined
  if (
    (fixture === 'analysis' || fixture === 'product-demo') &&
    intent.command === 'ask' &&
    intent.args.join(' ').trim()
  ) {
    return {
      data: structuredClone(
        fixture === 'product-demo' ? PRODUCT_DEMO_ANALYSIS_DATA : FIXTURE_ANALYSIS_DATA,
      ),
      notice: 'Analysis complete: 2 cited findings',
    }
  }
  if (fixture === 'comparison' && intent.command === 'compare' && intent.args.length === 2) {
    return {
      data: {
        ...structuredClone(FIXTURE_COMPARISON_RESULT),
        analysisId: 'analysis-fixture-comparison',
      },
      notice: 'Comparison complete: 1 paired run',
    }
  }
  return undefined
}
