import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AnalysisComparisonResult } from '../app/analysis-comparison-contracts.js'
import type { ForkPlan } from '../app/conversation-types.js'
import { interactionResponseBinding, parseInteractionRequest } from '../app/interaction-request.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { AnalysisRecord } from '../domain/entities.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import type { UiEvent } from '../views/shared/intents.js'
import type {
  AnalysisView,
  BraidViewModel,
  ComparisonView,
  ForkPreviewView,
} from '../views/shared/models.js'
import type { ProductOutput, SemanticEvalCaseId } from './types.js'

type ProductTheme = ReturnType<typeof import('../views/tui/theme.js')['createBraidTheme']>
type ProductForkPanel = InstanceType<
  typeof import('../views/tui/fork-preview.js')['ForkPreviewPanel']
>
type ProductAnalysisPanel = InstanceType<
  typeof import('../views/tui/analysis.js')['AnalysisViewPanel']
>

interface ProductPresenters {
  readonly packageRoot: string
  readonly createBraidTheme: (options: boolean | Record<string, unknown>) => ProductTheme
  readonly ForkPreviewPanel: new (theme: ProductTheme) => ProductForkPanel
  readonly AnalysisViewPanel: new (theme: ProductTheme) => ProductAnalysisPanel
  readonly analysisViewForRecord: (record: AnalysisRecord) => AnalysisView
  readonly analysisLines: (view: AnalysisView) => readonly string[]
  readonly isAnalysisComparisonResult: (value: unknown) => value is AnalysisComparisonResult
  readonly comparisonViewForResult: (result: AnalysisComparisonResult) => ComparisonView
  readonly comparisonLines: (view: ComparisonView) => readonly string[]
  readonly profileCompatibilityTextLines: (
    result: Readonly<Record<string, unknown>>,
    width?: number,
  ) => readonly string[]
  readonly plainEventText: (view: BraidViewModel, event: UiEvent) => string
  readonly projectSemanticEvent: (envelope: BraidEventEnvelope) => Readonly<Record<string, unknown>>
}

export interface ProductPresenterProvenance {
  readonly packageRoot: string
  readonly modulePaths: Readonly<Record<string, string>>
}

let presenters: ProductPresenters | null = null

function moduleUrl(packageRoot: string, relativePath: string): string {
  return pathToFileURL(join(packageRoot, 'dist', relativePath)).href
}

export async function loadProductPresenters(
  packageRoot: string,
): Promise<ProductPresenterProvenance> {
  const root = packageRoot.trim()
  if (root.length === 0)
    throw new Error('BRAID_EVAL_PACKAGE_ROOT is required for release presenters')
  const modules = {
    theme: moduleUrl(root, 'views/tui/theme.js'),
    fork: moduleUrl(root, 'views/tui/fork-preview.js'),
    analysis: moduleUrl(root, 'views/tui/analysis.js'),
    comparison: moduleUrl(root, 'views/tui/comparison.js'),
    profileCompatibility: moduleUrl(root, 'views/tui/profile-compatibility.js'),
    plain: moduleUrl(root, 'views/shared/plain-accessibility.js'),
    semantic: moduleUrl(root, 'views/shared/semantic-projection.js'),
  }
  const [theme, fork, analysis, comparison, profileCompatibility, plain, semantic] =
    await Promise.all([
      import(modules.theme),
      import(modules.fork),
      import(modules.analysis),
      import(modules.comparison),
      import(modules.profileCompatibility),
      import(modules.plain),
      import(modules.semantic),
    ])
  presenters = {
    packageRoot: root,
    createBraidTheme: theme.createBraidTheme as ProductPresenters['createBraidTheme'],
    ForkPreviewPanel: fork.ForkPreviewPanel as ProductPresenters['ForkPreviewPanel'],
    AnalysisViewPanel: analysis.AnalysisViewPanel as ProductPresenters['AnalysisViewPanel'],
    analysisViewForRecord:
      analysis.analysisViewForRecord as ProductPresenters['analysisViewForRecord'],
    analysisLines: analysis.analysisLines as ProductPresenters['analysisLines'],
    isAnalysisComparisonResult:
      comparison.isAnalysisComparisonResult as ProductPresenters['isAnalysisComparisonResult'],
    comparisonViewForResult:
      comparison.comparisonViewForResult as ProductPresenters['comparisonViewForResult'],
    comparisonLines: comparison.comparisonLines as ProductPresenters['comparisonLines'],
    profileCompatibilityTextLines:
      profileCompatibility.profileCompatibilityTextLines as ProductPresenters['profileCompatibilityTextLines'],
    plainEventText: plain.plainEventText as ProductPresenters['plainEventText'],
    projectSemanticEvent:
      semantic.projectSemanticEvent as ProductPresenters['projectSemanticEvent'],
  }
  return { packageRoot: root, modulePaths: modules }
}

function productPresenters(): ProductPresenters {
  if (presenters === null)
    throw new Error('Product presenters were not loaded from an installed package root')
  return presenters
}

function digest(value: unknown): string {
  return canonicalDigest(value)
}

function rendered(
  lines: readonly string[],
  path: ProductOutput['path'],
  source: unknown,
): ProductOutput {
  const text = lines.join('\n').trim()
  return {
    text,
    path,
    available: text.length > 0,
    missingReason: text.length > 0 ? null : 'The current Braid presenter returned no visible text',
    sourceDigest: digest(source),
  }
}

export function unavailableProductOutput(source: unknown, missingReason: string): ProductOutput {
  return {
    text: '',
    path: 'unavailable',
    available: false,
    missingReason,
    sourceDigest: digest(source),
  }
}

function forkPreview(plan: ForkPlan): ForkPreviewView {
  return {
    source: `${plan.sourceConversationId} / ${plan.sourceBranchId}`,
    destination: `${plan.sourceConversationId} / ${plan.destinationBranchId}`,
    kind: plan.kind,
    execution: {
      operationId: plan.operationId,
      planDigest: plan.digest,
    },
    fields: [
      {
        label: 'conversation context',
        source: plan.context.sourceBoundary,
        destination: `${plan.context.messages.length} messages`,
      },
      { label: 'provider session', source: 'current', destination: plan.providerSession },
      { label: 'workspace', source: 'current', destination: plan.environment },
      { label: 'checkpoint', source: 'source checkpoint', destination: plan.checkpoint },
    ],
    allowed: plan.allowed,
    ...(plan.reason === undefined ? {} : { unavailableReason: plan.reason }),
  }
}

function minimalView(overrides: Readonly<Record<string, unknown>> = {}): BraidViewModel {
  return {
    revision: 1,
    workspace: '/eval',
    profileName: 'Braid evaluation profile',
    runner: 'opencode',
    model: 'opencode/zai-coding-plan/glm-5.2',
    connection: 'CLI Bridge',
    conversationId: 'conversation-eval',
    conversationTitle: 'Braid evaluation',
    conversations: [],
    branch: 'branch-eval',
    status: 'ready',
    statusText: 'ready',
    queueCount: 0,
    sessionUsage: emptySessionUsage(),
    environments: [],
    messages: [],
    hiddenMessageCount: 0,
    runs: [],
    interactions: [],
    activity: [],
    graph: [],
    capabilities: {} as BraidViewModel['capabilities'],
    draft: '',
    selectedSurface: 'transcript',
    appearance: { color: 'none', highContrast: false, reducedMotion: true },
    ...overrides,
  }
}

function emptySessionUsage(): BraidViewModel['sessionUsage'] {
  const empty = {
    sourceCount: 0,
    input: 0,
    output: 0,
    tokenStatus: 'unknown' as const,
    costStatus: 'unknown' as const,
    unknownTokenSources: 0,
    unknownCostSources: 0,
  }
  return { turns: empty, analyses: empty, delegated: empty, attribution: 'complete' }
}

function renderFork(source: unknown): ProductOutput {
  if (source === null || typeof source !== 'object')
    return unavailableProductOutput(source, 'EVAL-01 fixture is not a Braid fork plan')
  const value = source as { readonly kind?: unknown; readonly plan?: unknown }
  if (value.kind !== 'braid.fork.plan' || value.plan === null || typeof value.plan !== 'object')
    return unavailableProductOutput(source, 'EVAL-01 fixture does not contain a Braid fork plan')
  const panel = new (productPresenters().ForkPreviewPanel)(
    productPresenters().createBraidTheme(false),
  )
  panel.setView(minimalView({ forkPreview: forkPreview(value.plan as ForkPlan) }))
  return rendered(panel.render(140), 'tui', source)
}

function renderInteraction(source: unknown): ProductOutput {
  if (source === null || typeof source !== 'object')
    return unavailableProductOutput(source, 'EVAL-02 fixture is not a Braid interaction request')
  const value = source as {
    readonly interaction?: unknown
    readonly run?: { readonly id?: unknown }
  }
  if (value.interaction === null || typeof value.interaction !== 'object')
    return unavailableProductOutput(source, 'EVAL-02 fixture has no complete InteractionRequest')
  const runId = typeof value.run?.id === 'string' ? value.run.id : 'run-eval-interaction'
  const request = parseInteractionRequest(value.interaction)
  if (request === undefined)
    return unavailableProductOutput(source, 'EVAL-02 fixture has no valid InteractionRequest')
  const event: BraidEvent = {
    kind: 'run.interaction',
    runId,
    request,
    responseBinding: interactionResponseBinding(request),
    provider: { eventId: `provider-interaction-${runId}`, providerSequence: 1 },
  }
  const projected = productPresenters().projectSemanticEvent({
    event,
    sequence: 1,
    revision: 1,
    occurredAt: new Date(0).toISOString(),
  })
  const uiEvent: UiEvent = { sequence: 1, revision: 1, kind: event.kind, payload: projected }
  return rendered(
    [
      productPresenters().plainEventText(
        minimalView({ status: 'waiting', statusText: 'waiting for permission' }),
        uiEvent,
      ),
    ],
    'plain',
    source,
  )
}

function renderAnalysis(source: unknown): ProductOutput {
  if (source === null || typeof source !== 'object')
    return unavailableProductOutput(source, 'EVAL-03 fixture is not a Braid analysis record')
  const value = source as { readonly analysis?: unknown }
  if (value.analysis === null || typeof value.analysis !== 'object')
    return unavailableProductOutput(source, 'EVAL-03 fixture has no AnalysisRecord')
  const view = productPresenters().analysisViewForRecord(value.analysis as AnalysisRecord)
  return rendered(productPresenters().analysisLines(view), 'tui', source)
}

function renderComparison(source: unknown): ProductOutput {
  if (source === null || typeof source !== 'object') {
    return unavailableProductOutput(source, 'EVAL-04 fixture is not a Braid comparison')
  }
  const value = source as { readonly comparison?: unknown }
  if (!productPresenters().isAnalysisComparisonResult(value.comparison)) {
    return unavailableProductOutput(source, 'EVAL-04 fixture has no complete comparison result')
  }
  const view = productPresenters().comparisonViewForResult(value.comparison)
  return rendered(productPresenters().comparisonLines(view), 'tui', source)
}

function renderReconnect(source: unknown): ProductOutput {
  if (source === null || typeof source !== 'object')
    return unavailableProductOutput(source, 'EVAL-05 fixture is not a Braid status event set')
  const value = source as { readonly events?: readonly BraidEvent[] }
  if (!Array.isArray(value.events) || value.events.length === 0)
    return unavailableProductOutput(source, 'EVAL-05 fixture has no complete status events')
  const lines = value.events.map((event, index) => {
    const projected = productPresenters().projectSemanticEvent({
      event,
      sequence: index + 1,
      revision: index + 1,
      occurredAt: new Date(0).toISOString(),
    })
    const statusText = typeof projected.status === 'string' ? projected.status : 'unknown'
    const uiEvent: UiEvent = {
      sequence: index + 1,
      revision: index + 1,
      kind: event.kind,
      payload: projected,
    }
    return productPresenters().plainEventText(
      minimalView({ status: statusText, statusText }),
      uiEvent,
    )
  })
  return rendered(lines, 'plain', source)
}

function renderProfileCompatibility(source: unknown): ProductOutput {
  if (source === null || typeof source !== 'object') {
    return unavailableProductOutput(source, 'EVAL-06 fixture is not a Braid profile selection')
  }
  const value = source as { readonly effective?: unknown }
  if (value.effective === null || typeof value.effective !== 'object') {
    return unavailableProductOutput(
      source,
      'EVAL-06 fixture has no effective profile compatibility result',
    )
  }
  return rendered(
    productPresenters().profileCompatibilityTextLines(
      value.effective as Readonly<Record<string, unknown>>,
      140,
    ),
    'tui',
    source,
  )
}

export function renderBraidProductOutput(
  caseId: SemanticEvalCaseId,
  semanticOutput: unknown,
): ProductOutput {
  if (presenters === null)
    return unavailableProductOutput(
      semanticOutput,
      'installed Braid product presenters were not loaded',
    )
  switch (caseId) {
    case 'EVAL-01':
      return renderFork(semanticOutput)
    case 'EVAL-02':
      return renderInteraction(semanticOutput)
    case 'EVAL-03':
      return renderAnalysis(semanticOutput)
    case 'EVAL-04':
      return renderComparison(semanticOutput)
    case 'EVAL-05':
      return renderReconnect(semanticOutput)
    case 'EVAL-06':
      return renderProfileCompatibility(semanticOutput)
  }
}
