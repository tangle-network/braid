# Analysis

## Job

Analysis runs a separate cited review over a frozen source run and makes progress, findings, evidence, cost, and completion inspectable.

## Best simple implementation

Freeze the source run through the shared analysis boundary.

Execute selected analyst profiles through Runtime.

Persist analysis lifecycle, model-call, usage, citation, finding, and terminal events in the Braid journal.

Project one immutable `AnalysisView` and render it through `AnalysisViewPanel`.

Do not mutate the source run or ask the analyzed run to grade itself.

## Component map

| Component | Responsibility |
| --- | --- |
| `AnalysisViewPanel` | Navigate analysis summary, findings, citations, model calls, usage, and terminal state. |

Shared presentation functions build the same document for terminal, plain, and headless output.

## Inputs and outputs

An analysis request names the frozen source run, selected analyst profiles, connection, question, budget, and operation identifier.

Progress events name their analysis and analyst execution.

Findings contain severity, claim, cited evidence references, confidence, and disposition state.

Promotion emits one explicit finding identifier and provenance record.

## Multi-analyst behavior

Each analyst execution keeps its own profile, model calls, usage, status, and failure.

The UI can filter or select analysts without dropping another analyst's fields.

Aggregate status reports the complete set of successful, failed, cancelled, and incomplete analysts.

A partial result remains partial and never appears as a clean comparison.

## Lifecycle and restart

Admission records the frozen source digest before model execution.

Live progress appends idempotent events by analysis and event identifiers.

Restart reconstructs progress and resumes or reconciles the runtime-owned execution.

Cancellation targets one analysis or analyst execution explicitly.

Promotion remains separate from analysis completion.

## Failure and safety

An invalid or missing citation blocks a finding from promotion.

Missing usage, cost, or model-call data stays unknown.

Late source events cannot change the frozen analysis input.

Cancelled analysis keeps bounded partial diagnostics and an honest cancelled state.

Trace artifacts exclude secrets and credential-bearing fields.

## Performance

Analysis pages render bounded findings and model calls.

Progress projection updates only the affected analysis record.

Parallel analysts use independent runtime executions within the declared budget.

## Proof

Tests cover freeze, progress, multiple analysts, citation resolution, budget termination, cancellation, restart, promotion, and source immutability.

Live proof requires real analyst model calls, settled usage and cost, resolved citations, and unchanged source data.

## Non-goals

Analysis does not become another conversation turn or provider session.

The UI does not invent a verdict when analyst evidence is incomplete.

