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


## First task over JSONL

Run [the first task example](../../examples/rpc-first-task.mjs) from an idle workspace with Braid installed.

`node examples/rpc-first-task.mjs` uses the `braid` executable found on `PATH`.

Set `BRAID_BIN` to select another executable, `BRAID_WORKSPACE` to select a workspace, or `BRAID_FIRST_TASK` to replace the prompt.

Set `BRAID_FIRST_TASK_TIMEOUT_MS` to change the five-minute task deadline; valid values range from 1 to 3600000.

The example initializes JSONL, requests the full state, and checks `view.capabilities['run.send']` before sending.

It refuses to send when the state contains active, detached, queued, or unknown work, so its shutdown cannot affect an earlier run.

Each request uses a fresh `req-<uuid>`; each mutation uses a fresh `op-<uuid>` operation ID.

The example polls `get_state` for the returned run ID and prints the public assistant output only after a completed run.

A send acknowledgement confirms acceptance and journaling; it does not prove the runner finished.

If the acknowledgement is lost, the example looks up the run by its operation ID and reports an unknown submission when it cannot reconcile it.

If the run requests human input, the example prints the public prompt and allowed outcomes, while hiding secret prompts.

It never answers or approves an interaction.

It detaches only this run when `run.detach` is available; otherwise, it requests cancellation of only this run when `run.cancel` is available.

If the example times out, it requests cancellation only for the run it created and only when `run.cancel` is available.

The result reports whether that disposition was confirmed; it never treats local process exit as provider cancellation.

When a disposition remains unknown, the example stops only its local RPC process without sending global `shutdown cancel`.

After a terminal run, it sends `shutdown` with `mode: 'wait'` and exits successfully only when completion, public output, and shutdown are confirmed.

The example does not reconnect or retry a submitted task.

After an unexpected disconnect, initialize a new JSONL connection and inspect its full state before acting.

Send `reconnect` for the existing run only when the fresh view reports `view.capabilities['run.reconnect'].available` as true.

Use a new request ID and a stable `op-` or `operation-` ID, and do not resend the task while its prior run is unresolved.

Run `pnpm test:rpc:packed:deterministic` to exercise the example with a deterministic packed binary and no provider calls.

Run `pnpm test:rpc:packed` to include the separate live-provider first-run proof; it requires the configured OpenCode bridge and provider credentials.

If `run.send` is unavailable, follow its reported reason and configure a supported profile and connection first.

## Shutdown and reconnect

Shutdown accepts `wait`, `detach`, or `cancel` as its mode.

`wait` drains active work before exit.

`detach` requires the active run to advertise `run.detach`.

It asks the provider to retain that run while Braid exits.

`cancel` requests provider cancellation and waits for its acknowledgement.

Closing the local stream alone does not prove the provider stopped.

A new connection must inspect the full state before it reconnects a run.

Send `reconnect` only when `view.capabilities['run.reconnect'].available` is true.

Braid and the provider must confirm the run and its last committed cursor before replay resumes.

If confirmation fails, the run remains detached, incomplete, expired, unauthorized, or unknown.

Do not report it as resumed or submit the same task again.

End-of-input applies the configured shutdown default.

Send `shutdown` explicitly to choose a disposition.


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
