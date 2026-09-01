# Multi-run orchestration

## Job

Multi-run orchestration admits and observes independent Braid runs without collapsing their branch or conversation identity.

It keeps one explicit focused run for foreground controls while every non-terminal run remains addressable.

It preserves continuation ordering on one branch while allowing different branches and conversations to stream concurrently.

## Best simple implementation

Keep one durable active-run index, one explicit focused run, and one independent reader per admitted run.

Serialize state commits through the journal while different branches execute concurrently.

Address every control, interaction, queue entry, and replay cursor by exact run and branch identity.

Do not add a global scheduler when branch admission and stable operation identities already provide the required ordering.

## Ownership

`BraidState.activeRuns` owns the durable index of active run identifiers and their immutable conversation and branch targets.

`BraidState.focusedRunId` owns the foreground focus used by navigation, controls, and interaction presentation.

`BraidState.activeRunId` remains a compatibility alias for the focused run when that run is active.

The reducer owns index normalization, event identity, lifecycle transitions, and duplicate-event handling.

Admission owns branch validation, per-branch exclusivity, immutable run receipts, and capability snapshots.

The durable sender owns admission reservations keyed by conversation and branch.

The execution controller owns one reader and abort controller per run.

The lifecycle and shutdown controllers own cancellation and drain decisions for locally live runs.

The journal remains authoritative for all run events and operation decisions.

## Inputs

Admission receives a text input, operation identifier, conversation identifier, branch identifier, profile snapshot, connection reference, and optional continuation proof.

Runtime readers receive the run receipt and an independent abort signal.

Reducers receive globally ordered durable events with run-local provider sequence and cursor metadata.

Navigation and focus receive typed intents that carry stable operation identifiers.

Queue entries carry their source run plus explicit conversation and branch identifiers when available.

## Outputs and intents

The reducer emits immutable state with active run references, one focused run, terminal compatibility data, and branch-scoped queues.

The execution controller emits typed run lifecycle, provider, interaction, usage, and terminal events through the journal.

The application accepts `focus-run`, explicit run control, branch navigation, branch creation, conversation navigation, and configuration intents while other runs continue.

The headless projection exposes the focused run and active run references without exposing provider-private state.

## State

An active run is any run with a non-terminal status, including a detached run that still requires explicit recovery.

A live run is any active run that still owns a local reader or control operation, excluding detached runs.

Each active reference contains only `runId`, `conversationId`, and `branchId`.

The normalizer derives active references from canonical run records after every reduction.

The normalizer keeps an existing focus when possible and selects the newest active run when focus becomes unavailable.

The normalizer clears the compatibility alias when focus is terminal or detached.

Snapshot restore accepts old snapshots with only `activeRunId` and reconstructs the active reference list from run records.

Snapshot restore rejects unknown, duplicate, or identity-mismatched active references before normalization.

## Algorithms

Admission rejects a second run only when an active run already targets the requested conversation and branch.

Admission materializes draft changes only for the selected branch and never mutates the immutable receipt of another run.

The durable sender holds one pending reservation per conversation and branch so independent branches can await admission together.

The execution controller starts each admitted run immediately and records provider sequence independently for each run.

Queue draining selects the oldest eligible entry whose target branch has no active run.

Queue draining leaves entries behind a live run and starts eligible entries on other branches.

Conversation and branch selection focus the active run for the selected target without stopping background readers.

Control requests carry the explicit target run identifier so a background run cannot receive focus-dependent control by accident.

Restart reconciliation scans every locally live run and performs provider status or replay recovery concurrently.

Shutdown cancels or detaches every locally live run with a distinct operation identifier.

## Concurrency

The journal transition tail serializes durable state changes while runtime readers remain independent.

Provider event deduplication keys include both run identifier and provider event identifier.

Run-local provider sequence checks do not treat another run's sequence as a gap.

The operation ledger serializes duplicate controls and queue drains by their stable operation identifiers.

Detached runs retain durable state but do not receive a local abort controller or automatic restart reader.

Focused-run changes never rewrite conversation, branch, turn, provider session, environment, or worker identifiers.

## Failures

An invalid target branch fails before admission and does not create an operation or provider call.

A same-branch admission race fails closed and leaves the existing run and queue intact.

A duplicate event with the same identity is acknowledged without another transition.

A duplicate event with a changed payload or position raises a durable conflict.

A disconnected reader uses the run's replay capability and cursor before declaring an unknown outcome.

Storage routes late provider events by run identity before it falls back to the selected conversation.

A provider cancellation acknowledgement settles only its target run and leaves other active runs unchanged.

An unknown cancellation remains unknown until provider evidence supports a correction.

An invalid persisted active reference quarantines the snapshot and allows journal recovery to proceed.

## Performance

Active-run lookup scans the bounded in-memory run projection by immutable branch identity.

Each runtime reader performs one independent event reduction and does not wait for another reader's provider call.

Restart reconciliation uses one asynchronous task per locally live run.

The compatibility alias adds no second source of truth because normalization derives it from focus and active records.

## Tests

`test/application.test.ts` proves concurrent branch streaming, same-branch queue ordering, focus switching, background interaction responses, background cancellation, disconnect replay, and duplicate provider events.

`test/storage-snapshots.test.ts` proves legacy active-run migration, invalid-reference quarantine, restart restoration, and duplicate conflict behavior.

`test/storage-journal-routing.test.ts` proves late background events remain in their run conversation after focus changes.

`test/cli-startup.test.ts` proves repeated signal captures retain the newest frame during active streaming.

`test/w8-runs.test.ts` retains single-run replay, cursor, cancellation, and queue coverage against the same ports.

The unit and storage scopes run the new cases through the production application core and journal interfaces.

## Non-goals

This component does not define agent identity, runner identity, provider session identity, environment identity, or worker identity.

This component does not launch runner processes or parse provider-native output.

This component does not create a global execution pool or reorder turns on one branch.

This component does not persist credential values, secret answers, or provider-private state.
