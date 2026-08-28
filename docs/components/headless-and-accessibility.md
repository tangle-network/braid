# Headless and accessible presentation

## Job

Headless and plain presentation expose the same Braid application state and commands without depending on an interactive terminal.

## Best simple implementation

Use the same controller, immutable view model, typed intents, and application core as the TUI.

Use bounded JSONL envelopes for automation.

Use semantic plain text for screen readers, logs, and non-TTY output.

Do not create a second reducer or test-only product path.

## Surfaces

The JSONL interface accepts versioned command envelopes with request and operation identifiers.

It emits direct responses, state snapshots, and events as bounded versioned envelopes.

Plain mode emits safe human-readable status and event lines.

Accessibility projection emits the selected transcript, status, pending decisions, and navigation meaning without ANSI styling.

## Inputs and outputs

Every mutating command requires a stable operation identifier.

Every direct response echoes the request identifier.

Errors include a stable code, safe message, and retryability.

Events include their canonical revision and entity identifiers.

Output fields preserve zero, null, unknown, and unavailable as distinct values.

## Bounds and backpressure

Input line size, JSON depth, command arguments, output envelope size, and cached request count are bounded.

Malformed input returns one error and does not desynchronize later lines.

Slow subscribers cannot grow an unbounded output queue.

State snapshots use the same bounded semantic projections as the terminal.

## Idempotency and restart

Duplicate request identifiers on one connection return the cached direct response.

Duplicate operation identifiers across connections reconcile through the journal.

Changed input under one operation identifier returns a conflict.

Restart restores durable application state before accepting new mutations.

## Failure and safety

JSONL stdout contains protocol envelopes only.

Diagnostics use stderr.

Secret values and credential references marked private never enter either output.

Untrusted text is sanitized and bounded before serialization or plain output.

## Performance

Projection reuses cached semantic state for one application revision.

Subscriber delivery coalesces high-frequency deltas while preserving durable terminal events.

## Proof

Contract tests run commands through headless, plain, virtual-terminal, and packed-binary surfaces against one application core.

Tests cover malformed input, bounds, duplicate request, duplicate operation, restart, backpressure, stdout purity, and accessibility text.

## Non-goals

The headless interface is not another agent runner or provider adapter.

Plain output does not expose terminal-only control sequences.
