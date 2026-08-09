import type { AnalystFinding } from '@tangle-network/agent-eval'
import {
  type AgentProfile,
  type InteractionRequest,
  permissionAnswerSpec,
} from '@tangle-network/agent-interface'
import { mapAnalystFinding } from '../adapters/analysis/citations.js'
import { buildAnalysisTraceStore } from '../adapters/analysis/trace-store.js'
import { compareFrozenRuns } from '../app/analysis-comparison-facts.js'
import { freezeAnalysisSource } from '../app/analysis-source.js'
import { DETERMINISTIC_PROFILE } from '../app/composition.js'
import { ConversationBranches } from '../app/conversation-branches.js'
import { createInteractionRequest } from '../app/interaction-request.js'
import { resolveEffectiveProfile } from '../app/profile-selection.js'
import { createProfileRecord } from '../app/profile-sources.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { BranchRecord, ConversationRecord, MessageRecord } from '../domain/entities.js'
import type { BraidEvent, JournalEventEnvelope } from '../domain/events.js'
import {
  createBranchId,
  createConversationId,
  createDraftId,
  createEnvironmentId,
  createEventId,
  createMessageId,
  createMessagePartId,
  createQueueId,
  createRunId,
  createProviderSessionId,
  createTurnId,
  createWorkspaceId,
} from '../domain/ids-values.js'
import { createAdmissionReceipt } from '../domain/receipts.js'
import { replayEvents } from '../domain/reducer.js'
import { type BraidState, initialState } from '../domain/state.js'
import { DEFAULT_RUN_CAPABILITIES } from '../ports/execution.js'
import {
  loadProductPresenters,
  type ProductPresenterProvenance,
  renderBraidProductOutput,
  unavailableProductOutput,
} from './product-path.js'
import type { CalibrationFixture, ReleaseFixture, SemanticEvalCaseId } from './types.js'

export const EVAL_NOW = '2026-08-03T20:00:00.000Z'
const LUNA_MODEL = 'pi/openai-codex/gpt-5.6-luna'
const ANTHROPIC_MODEL = 'anthropic/claude-opus-4-1'
const MOONSHOT_MODEL = 'moonshot/kimi-k2.5'
const OPENAI_MODEL = 'openai/gpt-5.6-luna'
const ZAI_MODEL = 'zai/glm-5.2'

function profileWith(
  model: string,
  harness: NonNullable<AgentProfile['harness']>,
): Readonly<AgentProfile> {
  return {
    ...DETERMINISTIC_PROFILE,
    harness,
    model: { ...(DETERMINISTIC_PROFILE.model ?? {}), default: model },
  }
}

function conversationState(suffix: string, messages: readonly MessageRecord[]): BraidState {
  const conversationId = createConversationId(`conversation-eval-${suffix}`)
  const branchId = createBranchId(`branch-eval-${suffix}`)
  const workspaceId = createWorkspaceId(`workspace-eval-${suffix}`)
  const tipMessageId = messages.at(-1)?.id
  const branch: BranchRecord = {
    id: branchId,
    conversationId,
    overrides: { runner: 'pi', model: LUNA_MODEL, effort: 'high' },
    draftId: createDraftId(`draft-eval-${suffix}`),
    queueId: createQueueId(`queue-eval-${suffix}`),
    ...(tipMessageId === undefined ? {} : { tipMessageId }),
    status: 'active',
    createdAt: EVAL_NOW,
    updatedAt: EVAL_NOW,
  }
  const conversation: ConversationRecord = {
    id: conversationId,
    workspaceId,
    title: `Braid evaluation ${suffix}`,
    activeBranchId: branchId,
    createdAt: EVAL_NOW,
    updatedAt: EVAL_NOW,
    archived: false,
    retention: {},
  }
  const base = initialState(DETERMINISTIC_PROFILE)
  return {
    ...base,
    workspace: `/workspace/${suffix}`,
    workspaceId,
    conversationId,
    branchId,
    conversations: [conversation],
    branches: [branch],
    messages,
  }
}

function textMessage(
  conversationId: ReturnType<typeof createConversationId>,
  branchId: ReturnType<typeof createBranchId>,
  id: string,
  role: 'user' | 'assistant',
  text: string,
): MessageRecord {
  const messageId = createMessageId(id)
  const partId = createMessagePartId(`part-${id}`)
  return {
    id: messageId,
    conversationId,
    branchId,
    role,
    text,
    partIds: [partId],
    status: 'complete',
    createdAt: EVAL_NOW,
    updatedAt: EVAL_NOW,
    complete: true,
    parts: [{ id: partId, kind: 'text', text }],
  }
}

function forkPlan(suffix: string, kind: 'conversation' | 'workspace', runner: string) {
  const conversationId = createConversationId(`conversation-eval-${suffix}`)
  const branchId = createBranchId(`branch-eval-${suffix}`)
  const user = textMessage(
    conversationId,
    branchId,
    `message-user-${suffix}`,
    'user',
    `Inspect the repository state for ${suffix}.`,
  )
  const assistant = textMessage(
    conversationId,
    branchId,
    `message-assistant-${suffix}`,
    'assistant',
    'The repository is ready for the next step.',
  )
  const state = conversationState(suffix, [user, assistant])
  const plan = new ConversationBranches({
    state: () => state,
    now: () => EVAL_NOW,
    commit: async () => undefined,
  }).plan({
    operationId: `operation-eval-fork-${suffix}`,
    conversationId,
    branchId,
    throughMessageId: assistant.id,
    kind,
    runner,
  })
  return { kind: 'braid.fork.plan', plan }
}

function permissionRequest(
  suffix: string,
  command: string,
  responseScopes: readonly ('interaction' | 'session' | 'persistent')[],
): InteractionRequest {
  const interactionId = `interaction-eval-${suffix}`
  const runId = `run-permission-${suffix}`
  return createInteractionRequest({
    id: interactionId,
    kind: 'permission',
    title: 'Permission required before running a command',
    body: `Braid paused before running ${command}. Choose a scope or deny the request.`,
    subject: { type: 'command', command },
    answerSpec: permissionAnswerSpec({ allowFeedback: true, responseScopes }),
    responseScopes: [...responseScopes],
    timeoutMs: 30_000,
    onTimeout: 'fail',
    binding: {
      runId,
      provider: 'eval-fixture',
      environmentId: 'environment-eval',
      sessionId: 'session-eval',
      executionId: runId,
      interactionId,
    },
  })
}

function permissionOutput(
  suffix: string,
  command: string,
  path: string,
  responseScopes: readonly ('interaction' | 'session' | 'persistent')[],
) {
  return {
    kind: 'braid.interaction.request',
    interaction: permissionRequest(suffix, command, responseScopes),
    run: {
      id: createRunId(`run-permission-${suffix}`),
      status: 'waiting',
      scope: responseScopes,
      subject: { path, command },
    },
  }
}

interface AnalysisFixtureResult {
  readonly analysis: unknown
  readonly evidence: ReturnType<typeof freezeAnalysisSource>
}

export function analysisEvidence(
  suffix: string,
  status: 'completed' | 'failed' = 'completed',
): AnalysisFixtureResult {
  const runId = createRunId(`run-analysis-${suffix}`)
  const turnId = createTurnId(`turn-analysis-${suffix}`)
  const state = initialState(DETERMINISTIC_PROFILE)
  const receipt = createAdmissionReceipt({
    runId: String(runId),
    turnId: String(turnId),
    operationId: `operation-analysis-${suffix}`,
    conversationId: String(state.conversationId),
    branchId: String(state.branchId),
    admittedAt: EVAL_NOW,
    profile: DETERMINISTIC_PROFILE,
    text: `Analyze ${suffix}.`,
    capabilities: DEFAULT_RUN_CAPABILITIES,
    provider: 'fixture-analysis-provider',
    providerSessionId: createProviderSessionId(`provider-session-fixture-${suffix}`),
    environmentId: createEnvironmentId(`environment-fixture-${suffix}`),
    admissionStatus: 'admitted',
  })
  const eventId = (sequence: number) => createEventId(`event-analysis-${suffix}-${sequence}`)
  const events: JournalEventEnvelope[] = [
    {
      eventId: eventId(1),
      sequence: 1,
      revision: 1,
      occurredAt: EVAL_NOW,
      event: { kind: 'workspace.opened', workspace: `/workspace/analysis-${suffix}` },
    },
    {
      eventId: eventId(2),
      sequence: 2,
      revision: 2,
      occurredAt: EVAL_NOW,
      event: {
        kind: 'run.requested',
        operationId: `operation-analysis-${suffix}`,
        runId,
        turnId,
        userMessageId: `message-analysis-user-${suffix}`,
        assistantMessageId: `message-analysis-assistant-${suffix}`,
        text: `Analyze ${suffix}.`,
        requestDigest: receipt.requestDigest,
        receipt,
      },
    },
    {
      eventId: eventId(3),
      sequence: 3,
      revision: 3,
      occurredAt: EVAL_NOW,
      event: {
        kind: 'run.tool.call',
        runId,
        partId: `part-analysis-${suffix}`,
        toolName: 'shell',
        callId: `call-analysis-${suffix}`,
        input: { command: `printf ${suffix}` },
        provider: { eventId: `provider-call-${suffix}`, providerSequence: 1 },
      },
    },
    {
      eventId: eventId(4),
      sequence: 4,
      revision: 4,
      occurredAt: EVAL_NOW,
      event: {
        kind: 'run.tool.result',
        runId,
        partId: `part-analysis-${suffix}`,
        toolName: 'shell',
        callId: `call-analysis-${suffix}`,
        result: `safe ${suffix}`,
        provider: { eventId: `provider-result-${suffix}`, providerSequence: 2 },
      },
    },
    {
      eventId: eventId(5),
      sequence: 5,
      revision: 5,
      occurredAt: EVAL_NOW,
      event: { kind: 'run.text.delta', runId, text: `Observed safe output for ${suffix}.` },
    },
    {
      eventId: eventId(6),
      sequence: 6,
      revision: 6,
      occurredAt: EVAL_NOW,
      event: {
        kind: 'run.finished',
        runId,
        status,
        finalText: status === 'completed' ? `Observed safe output for ${suffix}.` : '',
        usage: {
          input: suffix.includes('missing-cost') ? 120 : 100,
          output: suffix.includes('missing-cost') ? 60 : 50,
          ...(suffix.includes('baseline') ? { costUsd: 0.02 } : {}),
          model: 'fixture/eval-source',
        },
        ...(status === 'failed' ? { error: 'provider returned a recoverable error' } : {}),
      },
    },
  ]
  const replayed = replayEvents(state, events)
  const evidence = freezeAnalysisSource({ state: replayed, events, runId })
  const trace = buildAnalysisTraceStore(evidence)
  const textEvent = evidence.events.find((event) => event.event.kind === 'run.text.delta')
  if (textEvent === undefined) throw new Error(`Analysis fixture ${suffix} has no text event`)
  const finding: AnalystFinding = {
    schema_version: '1.0.0',
    finding_id: `finding-${suffix}`,
    analyst_id: 'efficiency-behavioral',
    produced_at: EVAL_NOW,
    severity: 'medium',
    area: 'tool-use',
    claim: `The ${suffix} run contains one observed shell result and no measured root cause.`,
    confidence: 0.72,
    evidence_refs: [
      {
        kind: 'event',
        uri: `event://${String(textEvent.id)}`,
        excerpt: `Observed safe output for ${suffix}.`,
      },
    ],
  }
  const mapped = mapAnalystFinding(evidence, trace, finding)
  const analysis = {
    kind: 'braid.analysis.record',
    analysis: {
      id: `analysis-${suffix}`,
      source: evidence.source,
      question: `What happened in ${suffix}?`,
      recipe: 'ask',
      status,
      findings: [mapped],
      usage: { input: 100, output: 30, model: 'fixture/analyst' },
      ...(suffix.includes('baseline') ? { costUsd: 0.01 } : {}),
      createdAt: EVAL_NOW,
      updatedAt: EVAL_NOW,
    },
  }
  return { analysis, evidence }
}

function comparisonOutput(suffix: string) {
  const baseline = analysisEvidence(`${suffix}-baseline`)
  const candidate = analysisEvidence(`${suffix}-missing-cost`, 'failed')
  const comparison = compareFrozenRuns({
    baseline: baseline.evidence,
    candidate: candidate.evidence,
    bootstrapSeed: 7,
  })
  return {
    kind: 'braid.analysis.comparison',
    source: { suffix, baseline: baseline.evidence.source, candidate: candidate.evidence.source },
    comparison,
  }
}

function reconnectOutput(suffix: string) {
  const events: BraidEvent[] = [
    {
      kind: 'run.detached',
      runId: createRunId(`run-reconnect-${suffix}-detached`),
      cursor: `cursor-${suffix}`,
      detail: 'local stream detached',
    },
    {
      kind: 'run.reconnecting',
      runId: createRunId(`run-reconnect-${suffix}-reconnecting`),
      after: `cursor-${suffix}`,
    },
    {
      kind: 'run.finished',
      runId: createRunId(`run-reconnect-${suffix}-cancelled`),
      status: 'cancelled',
      finalText: '',
      usage: { input: 1, output: 0 },
      reason: 'user_cancelled',
    },
    {
      kind: 'run.finished',
      runId: createRunId(`run-reconnect-${suffix}-failed`),
      status: 'failed',
      finalText: '',
      usage: { input: 1, output: 0 },
      error: 'provider failed',
    },
    {
      kind: 'run.finished',
      runId: createRunId(`run-reconnect-${suffix}-expired`),
      status: 'expired',
      finalText: '',
      usage: { input: 1, output: 0 },
      reason: 'response_window_expired',
    },
    {
      kind: 'run.unknown',
      runId: createRunId(`run-reconnect-${suffix}-unknown`),
      detail: 'provider history is unavailable',
    },
  ]
  return {
    kind: 'braid.semantic.run-statuses',
    events,
  }
}

function profileCompatibilityOutput(
  suffix: string,
  runner: NonNullable<AgentProfile['harness']>,
  model: string,
  compatibleModel: string,
) {
  const profile = createProfileRecord(
    {
      kind: 'inline',
      reference: `eval-profile-${suffix}`,
      label: `Eval profile ${suffix}`,
      writable: false,
      trusted: true,
    },
    profileWith(model, runner),
  )
  return {
    kind: 'braid.profile.selection',
    authoredProfile: profile.profile,
    profileDigest: profile.digest,
    effective: resolveEffectiveProfile({
      profile,
      availableModelIds: [model, compatibleModel],
    }),
  }
}

type CaseFixtureMap<T> = Readonly<Record<SemanticEvalCaseId, readonly [T, T, T]>>

const CALIBRATION_FIXTURES: CaseFixtureMap<CalibrationFixture> = {
  'EVAL-01': [
    {
      id: 'cal-fork-shared-conversation',
      semanticOutput: forkPlan('cal-fork-shared-conversation', 'conversation', 'opencode'),
      goodOutput:
        'The conversation context is copied through the assistant boundary, the destination provider session is new, the environment remains shared, and no checkpoint is made. Omitted provider-owned reasoning and tool state are not copied, so this is not a resumed session.',
      badOutput:
        'The fork resumes the original provider session with the same environment and checkpoint, so all hidden state is copied.',
      trivialOutput: 'Fork plan received.',
    },
    {
      id: 'cal-fork-workspace-unavailable',
      semanticOutput: forkPlan('cal-fork-workspace-unavailable', 'workspace', 'pi'),
      goodOutput:
        'The workspace fork is unavailable: conversation context is portable, but the environment and checkpoint are unavailable. Braid cannot claim a new workspace or resumed provider session; choose a conversation fork or configure the missing capabilities.',
      badOutput:
        'Workspace fork is ready and will resume the source session with copied environment and checkpoint.',
      trivialOutput: 'Workspace fork unavailable.',
    },
    {
      id: 'cal-fork-runner-boundary',
      semanticOutput: forkPlan('cal-fork-runner-boundary', 'conversation', 'codex'),
      goodOutput:
        'This conversation fork copies the selected messages and starts a new codex provider session. The environment is shared, checkpoint is none, and provider-owned reasoning and tool internals are omitted.',
      badOutput:
        'Everything, including provider session, environment, checkpoint, and hidden tool state, was cloned into codex.',
      trivialOutput: 'Conversation fork prepared.',
    },
  ],
  'EVAL-02': [
    {
      id: 'cal-permission-shell-read',
      semanticOutput: permissionOutput(
        'cal-permission-shell-read',
        'git diff -- README.md',
        'README.md',
        ['interaction', 'session'],
      ),
      goodOutput:
        'Braid is paused before running `git diff -- README.md`. The subject is that exact shell command; the offered scopes are this interaction or the current session, not persistent access. Deny, allow once, or allow for the session, with optional feedback.',
      badOutput:
        'Allow the agent to do what it needs; this may apply everywhere and is probably safe.',
      trivialOutput: 'Permission requested.',
    },
    {
      id: 'cal-permission-network-write',
      semanticOutput: permissionOutput(
        'cal-permission-network-write',
        'curl -X POST https://example.invalid',
        'network',
        ['interaction'],
      ),
      goodOutput:
        'The exact subject is `curl -X POST https://example.invalid`, a network write. Only this interaction is offered, not session or persistent scope. Deny or allow once; the run stays paused until you choose.',
      badOutput:
        'The network operation is fine; approve permanently so the agent does not pause again.',
      trivialOutput: 'Network permission needed.',
    },
    {
      id: 'cal-permission-delete',
      semanticOutput: permissionOutput(
        'cal-permission-delete',
        'rm -f build/cache.json',
        'build/cache.json',
        ['interaction', 'session', 'persistent'],
      ),
      goodOutput:
        'Braid requests permission for `rm -f build/cache.json`, which deletes that file. The offered choices are deny, once, session, or persistent; persistent approval affects future matching requests and should be explicit.',
      badOutput: 'Approve the broad file permission; request details and scope do not matter.',
      trivialOutput: 'A permission choice is waiting.',
    },
  ],
  'EVAL-03': [
    {
      id: 'cal-analysis-shell',
      semanticOutput: analysisEvidence('cal-analysis-shell').analysis,
      goodOutput:
        'The medium finding is supported by its citation to the frozen observed text event, confidence is 0.72, and the source shows no measured root cause. Inspect the cited shell result next; do not promote speculation into a causal claim.',
      badOutput:
        'The root cause is a shell security regression and the provider corrupted the repository; cite event://missing-root-cause.',
      trivialOutput: 'Analysis completed with one finding.',
    },
    {
      id: 'cal-analysis-timing',
      semanticOutput: analysisEvidence('cal-analysis-timing').analysis,
      goodOutput:
        'The finding is tied to the frozen trace and reports only what the event supports. Confidence 0.72 is bounded evidence; inspect the cited event before changing the system and do not assert an unsupported root cause.',
      badOutput:
        'The trace proves the provider timeout caused latency; no citation or uncertainty is needed.',
      trivialOutput: 'There is a trace finding.',
    },
    {
      id: 'cal-analysis-failed',
      semanticOutput: analysisEvidence('cal-analysis-failed', 'failed').analysis,
      goodOutput:
        'The finding cites an observed event, but the source run is failed. State that limitation, give the next diagnostic action, and avoid calling the finding a confirmed root cause.',
      badOutput:
        'The failed run proves the database caused the issue; promote it and cite an event absent from the source.',
      trivialOutput: 'A failed analysis has a finding.',
    },
  ],
  'EVAL-04': [
    {
      id: 'cal-comparison-cost',
      semanticOutput: comparisonOutput('cal-comparison-cost'),
      goodOutput:
        'Before a verdict, show the paired baseline and candidate fields: baseline cost is 0.02 USD while candidate cost is missing, and baseline completed while candidate failed. Report tokens, event counts, and latency separately; n=1 is descriptive, not a general cheaper-or-better claim.',
      badOutput: 'The candidate is 20% cheaper and better; both runs succeeded, so ship it.',
      trivialOutput: 'Comparison complete.',
    },
    {
      id: 'cal-comparison-outcome',
      semanticOutput: comparisonOutput('cal-comparison-outcome'),
      goodOutput:
        'List every field captured on either arm, mark candidate cost missing rather than zero, show baseline completed versus candidate failed, and limit the verdict because this has one pair.',
      badOutput:
        'Only latency matters; ignore missing cost and the failed candidate because the candidate wins.',
      trivialOutput: 'Baseline and candidate were compared.',
    },
    {
      id: 'cal-comparison-single-pair',
      semanticOutput: comparisonOutput('cal-comparison-single-pair'),
      goodOutput:
        'This is one paired observation. Show both IDs, every asymmetric field, missing candidate cost, completion versus failure, and the limitation that one pair cannot establish a reliable general result.',
      badOutput:
        'The sample is large enough to conclude the candidate is faster and cheaper; missing values can be zero.',
      trivialOutput: 'The arms differ.',
    },
  ],
  'EVAL-05': [
    {
      id: 'cal-reconnect-detach',
      semanticOutput: reconnectOutput('cal-reconnect-detach'),
      goodOutput:
        'Detached means the local stream stopped while the run may still exist; reconnecting requests events after the cursor. Cancelled, failed, and expired are distinct terminal results, while unknown means evidence is insufficient. Only detached and reconnecting invite recovery.',
      badOutput: 'All statuses mean complete and safe to resume; reconnect whenever possible.',
      trivialOutput: 'Run status changed.',
    },
    {
      id: 'cal-reconnect-gap',
      semanticOutput: reconnectOutput('cal-reconnect-gap'),
      goodOutput:
        'Distinguish the temporary detached stream, active reconnecting, and terminal cancelled, failed, expired, and unknown outcomes. Provider history being unavailable is not completion.',
      badOutput:
        'The provider gap is reconnecting, so the run will continue and no warning is needed.',
      trivialOutput: 'The run has several states.',
    },
    {
      id: 'cal-reconnect-cancelled',
      semanticOutput: reconnectOutput('cal-reconnect-cancelled'),
      goodOutput:
        'A detached stream may be reconnectable, but a later cancelled result is terminal. Failed, expired, and unknown remain distinct; unknown is unresolved evidence, not success.',
      badOutput:
        'Cancelled, failed, expired, and unknown are interchangeable labels for a completed run.',
      trivialOutput: 'The run is not active.',
    },
  ],
  'EVAL-06': [
    {
      id: 'cal-profile-glm-codex',
      semanticOutput: profileCompatibilityOutput(
        'cal-profile-glm-codex',
        'codex',
        ZAI_MODEL,
        OPENAI_MODEL,
      ),
      goodOutput:
        'The unsupported pair is harness=codex with model=zai/glm-5.2. Preserve the authored profile and explicitly choose opencode to keep GLM or openai/gpt-5.6-luna to keep codex; do not silently replace either field.',
      badOutput:
        'codex will silently choose a compatible model, so the profile is valid and no choice is needed.',
      trivialOutput: 'The profile is incompatible.',
    },
    {
      id: 'cal-profile-runner-choice',
      semanticOutput: profileCompatibilityOutput(
        'cal-profile-luna-claude',
        'claude-code',
        OPENAI_MODEL,
        ANTHROPIC_MODEL,
      ),
      goodOutput:
        'The mismatch is harness=claude-code with model=openai/gpt-5.6-luna. Select codex to preserve Luna or anthropic/claude-opus-4-1 to preserve claude-code; keep the authored profile and digest unchanged.',
      badOutput: 'Remove the model field and retry with pi; that changes nothing important.',
      trivialOutput: 'Choose another profile.',
    },
    {
      id: 'cal-profile-digest',
      semanticOutput: profileCompatibilityOutput(
        'cal-profile-claude-kimi',
        'kimi-code',
        ANTHROPIC_MODEL,
        MOONSHOT_MODEL,
      ),
      goodOutput:
        'The unsupported pair is harness=kimi-code with model=anthropic/claude-opus-4-1. Keep the authored profile unchanged and explicitly choose claude-code for that model or moonshot/kimi-k2.5 for kimi-code.',
      badOutput:
        'Omit the unsupported model and continue with a default runner; users do not need to know.',
      trivialOutput: 'Profile selection needs attention.',
    },
  ],
}

const RELEASE_SEMANTIC_OUTPUTS: CaseFixtureMap<unknown> = {
  'EVAL-01': [
    forkPlan('heldout-fork-conversation', 'conversation', 'opencode'),
    forkPlan('heldout-fork-workspace', 'workspace', 'pi'),
    forkPlan('heldout-fork-codex', 'conversation', 'codex'),
  ],
  'EVAL-02': [
    permissionOutput('heldout-permission-read', 'git diff -- package.json', 'package.json', [
      'interaction',
      'session',
    ]),
    permissionOutput(
      'heldout-permission-network',
      'curl -X POST https://example.invalid/api',
      'network',
      ['interaction'],
    ),
    permissionOutput('heldout-permission-delete', 'rm -f dist/cache.json', 'dist/cache.json', [
      'interaction',
      'session',
      'persistent',
    ]),
  ],
  'EVAL-03': [
    analysisEvidence('heldout-analysis-shell').analysis,
    analysisEvidence('heldout-analysis-timing').analysis,
    analysisEvidence('heldout-analysis-failed', 'failed').analysis,
  ],
  'EVAL-04': [
    comparisonOutput('heldout-comparison-cost'),
    comparisonOutput('heldout-comparison-outcome'),
    comparisonOutput('heldout-comparison-single-pair'),
  ],
  'EVAL-05': [
    reconnectOutput('heldout-reconnect-detach'),
    reconnectOutput('heldout-reconnect-gap'),
    reconnectOutput('heldout-reconnect-cancelled'),
  ],
  'EVAL-06': [
    profileCompatibilityOutput(
      'heldout-profile-moonshot-codex',
      'codex',
      MOONSHOT_MODEL,
      OPENAI_MODEL,
    ),
    profileCompatibilityOutput(
      'heldout-profile-glm-claude',
      'claude-code',
      ZAI_MODEL,
      ANTHROPIC_MODEL,
    ),
    profileCompatibilityOutput(
      'heldout-profile-luna-kimi',
      'kimi-code',
      OPENAI_MODEL,
      MOONSHOT_MODEL,
    ),
  ],
}

export const SEMANTIC_CALIBRATION_FIXTURES = CALIBRATION_FIXTURES

export const SEMANTIC_RELEASE_FIXTURES: CaseFixtureMap<ReleaseFixture> = Object.fromEntries(
  (Object.keys(RELEASE_SEMANTIC_OUTPUTS) as SemanticEvalCaseId[]).map((caseId) => [
    caseId,
    RELEASE_SEMANTIC_OUTPUTS[caseId].map((semanticOutput, index) => {
      const id = `release-${caseId.toLowerCase()}-${index + 1}`
      return {
        id,
        semanticOutput,
        productOutput: unavailableProductOutput(
          semanticOutput,
          'installed Braid product presenters were not loaded',
        ),
      }
    }),
  ]),
) as unknown as CaseFixtureMap<ReleaseFixture>

export async function prepareReleaseProductOutputs(
  packageRoot: string,
): Promise<ProductPresenterProvenance> {
  const provenance = await loadProductPresenters(packageRoot)
  for (const caseId of Object.keys(SEMANTIC_RELEASE_FIXTURES) as SemanticEvalCaseId[]) {
    for (const fixture of SEMANTIC_RELEASE_FIXTURES[caseId]) {
      const mutable = fixture as { productOutput: ReleaseFixture['productOutput'] }
      mutable.productOutput = renderBraidProductOutput(caseId, fixture.semanticOutput)
    }
  }
  return provenance
}

export function releaseFixtureProductReady(): boolean {
  return (Object.keys(SEMANTIC_RELEASE_FIXTURES) as SemanticEvalCaseId[]).every((caseId) =>
    SEMANTIC_RELEASE_FIXTURES[caseId].every(
      (fixture) =>
        fixture.productOutput.sourceDigest === canonicalDigest(fixture.semanticOutput) &&
        fixture.productOutput.path !== 'unavailable',
    ),
  )
}
