import type { TraceAnalystSpan } from '@tangle-network/agent-eval'
import { type RunRecord, validateRunRecord } from '@tangle-network/agent-eval'

export interface W11SemanticFixture {
  readonly id: string
  readonly good: string
  readonly bad: string
  readonly trivial: string
}

export interface W11SemanticCase {
  readonly id: `EVAL-0${1 | 2 | 3 | 4 | 5 | 6}`
  readonly dimension: string
  readonly fixtures: readonly W11SemanticFixture[]
}

export interface W11AnalysisCase {
  readonly id: `AN-${string}`
  readonly assertion: string
}

/** Deterministic unit fixtures only; these are never reported as live evidence. */
export const W11_SEMANTIC_CASES: readonly W11SemanticCase[] = [
  {
    id: 'EVAL-01',
    dimension: 'fork copy semantics',
    fixtures: [
      {
        id: 'EVAL-01-fixture-1',
        good: 'This conversation fork copies selected normalized messages into a new branch. It does not copy the provider session, environment, checkpoint, pending interactions, or prior analysis unless explicitly selected.',
        bad: 'The whole session was resumed in a new branch.',
        trivial: '{"forkKind":"conversation","status":"created"}',
      },
      {
        id: 'EVAL-01-fixture-2',
        good: 'This environment fork checkpoints the source workspace, creates an independent destination environment, and starts a new provider session. The source environment and its opaque provider state remain unchanged.',
        bad: 'The workspace was copied, so everything continues exactly where it stopped.',
        trivial: '{"checkpoint":"cp-7","environment":"env-9"}',
      },
      {
        id: 'EVAL-01-fixture-3',
        good: 'This cross-runner handoff transfers only the accepted portable context receipt to a fresh session. Runner-private state and unselected assistant output are omitted, so this is not a native resume.',
        bad: 'The other runner resumes the original session.',
        trivial: '{"runner":"codex","receipt":"ctx-4"}',
      },
    ],
  },
  {
    id: 'EVAL-02',
    dimension: 'permission clarity',
    fixtures: [
      {
        id: 'EVAL-02-fixture-1',
        good: 'The shell command `npm test` wants to run in the current workspace and may modify generated files. Choose Allow once to approve only this request or Deny to leave it blocked.',
        bad: 'Permission needed. Allow or deny?',
        trivial: '{"kind":"permission","subject":"shell"}',
      },
      {
        id: 'EVAL-02-fixture-2',
        good: 'The runner requests a secret credential for this single interaction. Entering it sends the value through the bounded response path; Braid will not journal, display again, export, or automate the secret.',
        bad: 'Enter your token so the agent can continue.',
        trivial: '{"field":{"type":"secret"}}',
      },
      {
        id: 'EVAL-02-fixture-3',
        good: 'Persistent approval is unavailable because this provider supports only one-request responses. Allow once and Deny remain available; Braid will not offer a control the provider cannot honor.',
        bad: 'Persistent approval is disabled.',
        trivial: '{"scopes":["interaction"]}',
      },
    ],
  },
  {
    id: 'EVAL-03',
    dimension: 'ask analysis',
    fixtures: [
      {
        id: 'EVAL-03-fixture-1',
        good: 'The cited tool span ended with “permission denied” after the read attempt. That establishes the immediate failure, not its root cause. Check the workspace permission policy next and replay the cited span after any change.',
        bad: 'The sandbox policy is definitely broken; disable it.',
        trivial: '{"status":"ERROR","message":"permission denied"}',
      },
      {
        id: 'EVAL-03-fixture-2',
        good: 'The cited trace shows three model calls and two repeated tool attempts, with cost missing for one call. The source supports investigating the repeated attempt; it does not support a total-cost claim until the missing receipt is recovered.',
        bad: 'The agent wastes money by calling the model too often.',
        trivial: '{"modelCalls":3,"toolCalls":2,"cost":null}',
      },
      {
        id: 'EVAL-03-fixture-3',
        good: 'No error span appears in the frozen source, so this analysis cannot claim a failure cause. The cited terminal event confirms completion; inspect the user-visible output or capture a failing run before diagnosing further.',
        bad: 'The run succeeded and there is nothing else to investigate.',
        trivial: '{"errors":0,"terminal":"completed"}',
      },
    ],
  },
  {
    id: 'EVAL-04',
    dimension: 'paired comparison',
    fixtures: [
      {
        id: 'EVAL-04-fixture-1',
        good: 'Two scenario-and-seed pairs are comparable; the baseline has one unmatched retry that is shown separately. On the matched rows, treatment wins one outcome and ties one, while using 240 versus 260 total tokens.',
        bad: 'Treatment wins because its average score is higher.',
        trivial: '{"baselineMean":0.7,"treatmentMean":0.8}',
      },
      {
        id: 'EVAL-04-fixture-2',
        good: 'Both arms completed the same three scenarios, but treatment cost is unavailable for one row. Outcomes, tokens, and wall time are shown for all rows; no cost winner is declared because the missing value remains unknown.',
        bad: 'Treatment is cheaper because its recorded cost is lower.',
        trivial: '{"baselineCost":0.06,"treatmentCost":0.03}',
      },
      {
        id: 'EVAL-04-fixture-3',
        good: 'Pairing uses scenario ID and seed, not array order. One baseline failure and one treatment cancellation remain visible alongside model, runner, attempts, tokens, cost, wall time, tool activity, and trace completeness before the verdict.',
        bad: 'The first three rows were compared and treatment looked better.',
        trivial: '[0.4,0.8,0.9]',
      },
    ],
  },
  {
    id: 'EVAL-05',
    dimension: 'reconnect state',
    fixtures: [
      {
        id: 'EVAL-05-fixture-1',
        good: 'Braid is detached from a run that the provider still reports as running. Reconnect is available; no cancellation is implied, and the last confirmed event remains visible until newer replay arrives.',
        bad: 'The run stopped when the terminal disconnected.',
        trivial: '{"connection":"detached","run":"running"}',
      },
      {
        id: 'EVAL-05-fixture-2',
        good: 'The provider reports the retained run as cancelled with an exact terminal receipt. Reconnect can show its history but cannot resume or steer it; start a new turn to continue.',
        bad: 'Reconnect failed. Try again.',
        trivial: '{"status":"cancelled"}',
      },
      {
        id: 'EVAL-05-fixture-3',
        good: 'The saved run reference exists locally, but the provider returns no matching run. Its state is unknown rather than failed or cancelled, so Braid disables control actions and offers a fresh-session handoff.',
        bad: 'The run expired and failed.',
        trivial: '{"local":true,"remote":null}',
      },
    ],
  },
  {
    id: 'EVAL-06',
    dimension: 'profile incompatibility',
    fixtures: [
      {
        id: 'EVAL-06-fixture-1',
        good: 'This provider cannot materialize `prompt.systemPrompt`, so Braid did not dispatch the profile. Choose a compatible provider or edit that field explicitly; Braid will not silently remove it.',
        bad: 'The profile was simplified to work with this provider.',
        trivial: '{"unsupported":["prompt.systemPrompt"]}',
      },
      {
        id: 'EVAL-06-fixture-2',
        good: 'The selected runner does not support the profile’s `mcp.servers` entries. Dispatch remains blocked, with the original profile unchanged; select a runner with MCP support or remove the entries and save a new profile revision.',
        bad: 'MCP is unavailable, but the rest of the profile can run.',
        trivial: '{"capability":"mcp","supported":false}',
      },
      {
        id: 'EVAL-06-fixture-3',
        good: 'The connection accepts inline profiles but not the named profile reference `reviewer`. Resolve it to an immutable inline snapshot or choose a connection that supports named profiles; no run was created.',
        bad: 'The named profile could not be found, so a default profile was used.',
        trivial: '{"namedProfiles":false,"profile":"reviewer"}',
      },
    ],
  },
]

export const W11_ANALYSIS_CASES: readonly W11AnalysisCase[] = [
  {
    id: 'AN-01',
    assertion: 'The analysis freezes one immutable source digest and late events cannot change it.',
  },
  {
    id: 'AN-02',
    assertion: 'Analysis creates no source-branch message or context mutation before promotion.',
  },
  {
    id: 'AN-03',
    assertion: 'Every analysis citation resolves inside the frozen source range.',
  },
  {
    id: 'AN-04',
    assertion:
      'A completed result contains findings, citations, provenance, budget, and telemetry.',
  },
  { id: 'AN-05', assertion: 'Analysis recipes execute through the canonical agent-eval registry.' },
  {
    id: 'AN-06',
    assertion: 'The semantic judge is calibrated on independent labeled fixtures first.',
  },
  {
    id: 'AN-07',
    assertion: 'Promotion records source digest and explicit cited finding provenance.',
  },
  { id: 'AN-08', assertion: 'Feedback is exported as a redacted structured trajectory.' },
  { id: 'AN-09', assertion: 'Headless and terminal analysis commands use one application path.' },
  { id: 'AN-10', assertion: 'Cancelling analysis does not cancel the analyzed source run.' },
]

export interface CalibrationPair {
  readonly id: string
  readonly category: 'cited-analysis' | 'fork-explanation' | 'permission' | 'comparison'
  readonly good: { readonly label: 'good'; readonly text: string }
  readonly bad: { readonly label: 'bad'; readonly text: string }
  readonly trivial: { readonly label: 'trivial'; readonly text: string }
}

const CALIBRATION_FIXTURES = [
  [
    'cited-analysis',
    'The answer cites an observed span and labels the root cause as unknown.',
    'The answer states a root cause without evidence.',
  ],
  [
    'cited-analysis',
    'The answer gives one next diagnostic step tied to the cited trace.',
    'The answer repeats the question without a next step.',
  ],
  [
    'cited-analysis',
    'The answer states what the source does not establish.',
    'The answer presents an inference as a measured fact.',
  ],
  [
    'fork-explanation',
    'The new branch carries an analysis attachment and selected findings.',
    'The new branch copies the old assistant answer as its starting state.',
  ],
  [
    'fork-explanation',
    'The fork records the source digest used for the selected findings.',
    'The fork omits which frozen source produced the findings.',
  ],
  [
    'fork-explanation',
    'The fork is rejected when the source changed before the action.',
    'The fork proceeds using stale evidence.',
  ],
  [
    'permission',
    'An unsupported provider action is disabled with a plain explanation.',
    'The UI exposes an action the provider cannot perform.',
  ],
  [
    'permission',
    'A supported action remains available and reports its stable operation ID.',
    'All actions are disabled even when supported.',
  ],
  [
    'permission',
    'Credential answers use the bounded response path and are not logged.',
    'The credential is written into a profile or analysis artifact.',
  ],
  [
    'comparison',
    'The report shows matched, unmatched, cost, outcome, and missing dimensions.',
    'The report shows only the winning score.',
  ],
  [
    'comparison',
    'Pairing uses the same scenario and seed identity on both arms.',
    'Pairing follows array order.',
  ],
  [
    'comparison',
    'The report marks uncaptured cost as unknown instead of zero.',
    'The report converts missing cost to zero.',
  ],
] as const

/** Independently labeled calibration fixtures; no label is inferred from judge output. */
export const W11_CALIBRATION_PAIRS: readonly CalibrationPair[] = CALIBRATION_FIXTURES.map(
  ([category, good, bad], index) => ({
    id: `calibration-${String(index + 1).padStart(2, '0')}`,
    category,
    good: { label: 'good', text: good },
    bad: { label: 'bad', text: bad },
    trivial: { label: 'trivial', text: 'The result looks fine.' },
  }),
)

function span(
  traceId: string,
  spanId: string,
  name: string,
  status: TraceAnalystSpan['status'],
  message?: string,
  toolName?: string,
): TraceAnalystSpan {
  return {
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: null,
    name,
    kind: toolName ? 'TOOL' : 'AGENT',
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: '2026-01-01T00:00:00.100Z',
    duration_ms: 100,
    status,
    ...(message ? { status_message: message } : {}),
    service_name: 'braid-test',
    agent_name: 'braid-fixture',
    model_name: 'braid-test-model@2026-01-01',
    tool_name: toolName ?? null,
    attributes: { fixture: true, ...(toolName ? { 'tool.name': toolName } : {}) },
  }
}

export const W11_TRACE_SPANS: readonly TraceAnalystSpan[] = [
  span('trace-w11-1', 'span-w11-agent', 'agent.turn', 'OK'),
  span('trace-w11-1', 'span-w11-tool', 'tool.exec', 'OK', undefined, 'shell'),
  span(
    'trace-w11-2',
    'span-w11-error',
    'agent.turn',
    'ERROR',
    'permission denied while opening workspace',
  ),
]

export function makeW11RunRecord(
  caseId: string,
  arm: 'baseline' | 'treatment',
  index: number,
): RunRecord {
  const record: RunRecord = {
    runId: `w11-${caseId.toLowerCase()}-${arm}-${index}`,
    experimentId: `w11-${caseId}`,
    candidateId: arm,
    seed: index,
    model: 'braid-test-model@2026-01-01',
    promptHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    configHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    commitSha: 'cccccccccccccccccccccccccccccccccccccccc',
    wallMs: arm === 'treatment' ? 80 + index : 100 + index,
    costUsd: arm === 'treatment' ? 0.01 : 0.02,
    costProvenance: { kind: 'estimated', usd: arm === 'treatment' ? 0.01 : 0.02 },
    tokenUsage: { input: 100 + index, output: 40 + index },
    terminalOutcome: 'succeeded',
    outcome: {
      raw: {
        pass: arm === 'treatment' || index > 1 ? 1 : 0,
        score: arm === 'treatment' ? 0.9 : 0.7,
      },
    },
    splitTag: 'holdout',
    scenarioId: `${caseId}-scenario-${index}`,
  }
  return validateRunRecord(record)
}

/** Synthetic unit records only. They are not semantic measurements or live evidence. */
export const W11_UNIT_FIXTURE_RUN_RECORDS: readonly RunRecord[] = [
  ...W11_SEMANTIC_CASES.flatMap((item) =>
    [1, 2, 3].flatMap((index) => [
      makeW11RunRecord(item.id, 'baseline', index),
      makeW11RunRecord(item.id, 'treatment', index),
    ]),
  ),
  ...W11_ANALYSIS_CASES.map((item, index) =>
    makeW11RunRecord(item.id, index % 2 === 0 ? 'treatment' : 'baseline', index + 1),
  ),
]
