import type { AnalysisComparisonResult } from '../../app/analysis-comparison-contracts.js'
import {
  comparisonDetails,
  comparisonLines,
  comparisonViewForResult,
  isAnalysisComparisonResult,
} from '../shared/comparison-presentation.js'
import type { ComparisonView } from '../shared/models.js'
import { EntityBrowser, type EntityBrowserDocument } from './entity-browser.js'
import type { BraidTheme } from './theme.js'

export { comparisonLines, comparisonViewForResult, isAnalysisComparisonResult }

/** Compatibility wrapper over the same browser used by the production comparison surface. */
export class ComparisonViewPanel extends EntityBrowser {
  readonly #setView: (view: ComparisonView | undefined) => void

  constructor(theme: BraidTheme) {
    let view: ComparisonView | undefined
    super(theme, {
      document: () => comparisonBrowserDocument(view),
      rows: () => 12,
      onClose: () => {},
      selectedId: 'comparison',
      openSelected: true,
    })
    this.#setView = (value) => {
      view = value
    }
  }

  setResult(result: AnalysisComparisonResult): void {
    this.setView(comparisonViewForResult(result))
  }

  setView(view: ComparisonView): void {
    this.#setView(view)
    this.selectId('comparison', true)
  }
}

function comparisonBrowserDocument(view: ComparisonView | undefined): EntityBrowserDocument {
  if (view === undefined) {
    return {
      title: 'analyses',
      emptyMessage: 'No frozen comparison is available.',
      rows: [],
    }
  }
  return {
    title: 'analyses',
    emptyMessage: 'No frozen comparison is available.',
    rows: [
      {
        id: 'comparison',
        kind: 'analysis',
        title: '/compare · frozen runs',
        status: 'complete',
        detailLines: comparisonDetails(view),
      },
    ],
  }
}
