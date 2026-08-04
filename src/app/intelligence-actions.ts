import type { RuntimeSupervisorController } from '../adapters/runtime/supervisor-control.js'
import type { RuntimeSupervisorWatcher } from '../adapters/runtime/supervisor-watch.js'
import { AnalysisComparisonService } from './analysis-comparison.js'
import { AnalysisPromotionService } from './analysis-promotion.js'
import { AnalysisService } from './analysis-service.js'
import type { AnalysisApplicationHost } from './analysis-types.js'
import { SupervisorService } from './supervisor-service.js'
import type { AnalysisAnalyst } from './analysis-execution-session.js'

/**
 * Product-owned composition for analysis and supervisor actions.
 *
 * The individual services own their domain behavior; this object only gives
 * the application and UI one stable entry point to the focused services.
 */
export class IntelligenceActions {
  readonly analysis: AnalysisService
  readonly comparison: AnalysisComparisonService
  readonly promotion: AnalysisPromotionService
  readonly supervisor: SupervisorService

  constructor(host: AnalysisApplicationHost, options: IntelligenceActionsOptions = {}) {
    this.analysis = new AnalysisService(host, options.analyst)
    this.comparison = new AnalysisComparisonService(host)
    this.promotion = new AnalysisPromotionService(host)
    this.supervisor = new SupervisorService(host, {
      ...(options.supervisorWatcher === undefined ? {} : { watcher: options.supervisorWatcher }),
      ...(options.supervisorController === undefined
        ? {}
        : { controller: options.supervisorController }),
    })
  }
}

export interface IntelligenceActionsOptions {
  readonly analyst?: AnalysisAnalyst
  readonly supervisorWatcher?: RuntimeSupervisorWatcher
  readonly supervisorController?: RuntimeSupervisorController
}

export function createIntelligenceActions(
  host: AnalysisApplicationHost,
  options: IntelligenceActionsOptions = {},
): IntelligenceActions {
  return new IntelligenceActions(host, options)
}
