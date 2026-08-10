import type { AnalysisRecord } from '../../domain/entities.js'
import {
  analysisDocument,
  analysisLines,
  analysisViewForRecord,
} from '../shared/analysis-presentation.js'
import type { AnalysisView, BraidViewModel } from '../shared/models.js'
import { EntityBrowser, type EntityBrowserDocument } from './entity-browser.js'
import type { BraidTheme } from './theme.js'

export { analysisLines, analysisViewForRecord }

/** Compatibility wrapper over the same browser used by the production analysis surface. */
export class AnalysisViewPanel extends EntityBrowser {
  readonly #setAnalysis: (analysis: AnalysisView | undefined) => void

  constructor(theme: BraidTheme) {
    let analysis: AnalysisView | undefined
    super(theme, {
      document: () => analysisBrowserDocument(analysis),
      rows: () => 12,
      onClose: () => {},
      selectedId: 'analysis',
      openSelected: true,
    })
    this.#setAnalysis = (value) => {
      analysis = value
    }
  }

  setView(view: BraidViewModel): void {
    this.setAnalysis(view.analysis)
  }

  setRecord(record: AnalysisRecord): void {
    this.setAnalysis(analysisViewForRecord(record))
  }

  setAnalysis(analysis: AnalysisView | undefined): void {
    this.#setAnalysis(analysis)
    this.selectId('analysis', analysis !== undefined)
  }
}

function analysisBrowserDocument(analysis: AnalysisView | undefined): EntityBrowserDocument {
  if (analysis === undefined) {
    return {
      title: 'analyses',
      emptyMessage: 'No frozen analysis result is available.',
      rows: [],
    }
  }
  const document = analysisDocument(analysis)
  return {
    title: 'analyses',
    emptyMessage: 'No frozen analysis result is available.',
    rows: [
      {
        id: 'analysis',
        kind: 'analysis',
        title: document.heading,
        status: analysis.status,
        detailLines: [...document.context, ...document.details],
      },
    ],
  }
}
