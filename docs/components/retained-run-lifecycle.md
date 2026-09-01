# Retained run lifecycle

## Purpose

The retained run lifecycle keeps one provider execution observable and controllable after a client disconnects or restarts.

It preserves exact provider identity and never treats a new execution as a recovered run.

## Ownership

`agent-interface` owns exact control references, capability documents, events, interactions, and control acknowledgements.

`agent-runtime` owns retained handles, provider reconnection, replay cursors, status reconciliation, and idempotent controls.

Braid owns durable admission receipts, local event reduction, reconnect scheduling, user intents, and terminal presentation.

The provider owns the live process, native session, environment, and final execution result.

## Best simple implementation

Braid records intent before any provider mutation.

Runtime records the environment and exact control reference as each provider boundary succeeds.

Every identity field is explicit: Braid run, provider run, environment, execution, session, turn, and operation.

Reconnect uses the saved exact control reference and the last accepted event sequence.

Replay rejects duplicates before reduction and records sequence gaps without inventing provider output.

Detach closes only the local reader and leaves the provider run active.

Cancel uses one stable operation identifier and reconciles an ambiguous acknowledgement through exact provider status.

Unknown status remains unknown until a later exact observation resolves it.

The implementation never parses runner output or reads provider-private state.

## Durable phases

| Phase | Durable fact | Safe restart action |
| --- | --- | --- |
| Intent | Request digest, provider, session, execution, and environment key | Repeat admission with the same identifiers. |
| Environment | Exact created environment plus the intent facts | Discover the matching execution before dispatch. |
| Dispatched | Complete exact control reference | Reconnect the retained handle and replay after the saved sequence. |
| Terminal | Final provider result and local terminal event | Render the saved result and perform no provider mutation. |

A changed request with the same operation identifier fails as a conflict.

A repeated request with the same digest returns the original acknowledgement.

## Concurrency and performance

Each Braid run has one prepared plan, one start promise, one retained handle, and one active reader.

Replacing a reader aborts the old reader before the new stream consumes events.

Process-local retained state is bounded and evicts only runs without preparation, startup, or active readers.

Provider discovery uses bounded pages and validates every returned identity field.

The event journal remains authoritative for the conversation graph and accepted local sequence.

## User interface

The Work Strip shows streaming, waiting, detached, cancelling, terminal, and unknown states for every active run.

Focus changes the visible transcript without changing which run a control targets.

Detach, reconnect, cancel, and interaction actions appear only when the reported capabilities support them.

Unavailable actions remain visible with one plain reason.

## Failure behavior

An ambiguous environment or dispatch response triggers lookup with the original identifiers.

Duplicate environments, conflicting control references, stale sessions, and malformed acknowledgements fail closed.

A client crash does not imply provider cancellation.

A stream disconnect does not imply run failure.

Credentials and raw provider payloads never enter the journal, frame captures, or diagnostics.

## Proof

Tests cover intent, environment, and dispatch crashes; restart; replay; duplicate events; sequence gaps; detach; reconnect; cancel; and interaction recovery.

Live proof kills the first Braid process, reconnects from another process, advances the same session, cancels, and cleans the exact environment.

Release proof also requires concurrent runs because one retained handle must never block an unrelated branch.

## Non-goals

Braid does not implement a runner, provider session store, or retained execution protocol.

Braid does not infer continuity from matching text, workspace paths, or display labels.
