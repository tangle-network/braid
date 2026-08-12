# ADR 004: Coordinate durable effects before external dispatch

Status: accepted

Date: 2026-08-02

## Context

Braid's terminal and headless interfaces can retry after a response window, process restart, or transport failure.

The existing vertical slice protected one process with an operation map, but that map was not a storage boundary and could not distinguish a changed retry from the original request.

The application must not dispatch a durable or external mutation until its caller operation identifier and canonical request digest are durably recorded.

## Decision

Braid uses `SerializedEffectCoordinator` over `EffectStoragePort` for retry-safe external effects.

The coordinator atomically admits `pending` before dispatch, serializes handlers, and appends one provider-neutral outcome record for `acknowledged`, `failed`, `unknown`, or `terminal` results.

The first request digest owns an operation identifier through a durable admission row with a uniqueness constraint.

An identical operation and digest returns the existing record without dispatching again.

A changed digest writes a conflict audit record and dispatches nothing.

An exception crossing the dispatch boundary becomes `unknown` because the provider may have accepted the request before the client observed the exception.

Provider-supplied diagnostics are reduced to bounded machine-safe details before an effect record is persisted.

If a local terminal event cannot be committed after provider dispatch, the effect remains `unknown` and the run remains eligible for explicit reconciliation rather than being acknowledged.

A previously pending operation is resolved only through an explicit reconciliation handler.

Without reconciliation evidence the coordinator leaves it pending and never guesses that repeating the mutation is safe.

A pending local effect is not a remote control reference.

Remote retention requires provider lookup for success that occurred before the exact reference committed.

`JournalPort` and `EffectStoragePort` are application seams rather than new provider protocols.

## Consequences

Controllers can use one operation identity across terminal retries, headless reconnects, and process recovery.

Storage failures before the pending append prevent dispatch entirely.

The deterministic fixture can use `MemoryJournal` through the same ports without changing the reducer or event union.

The SQLite implementation and credential facilities satisfy this contract through the production `EffectStoragePort`; the deterministic memory adapter remains fixture-only.

## Verification

`test:coordination`, `test:storage`, and the native two-process admission test prove pending-before-dispatch ordering, same-digest replay, changed-input conflict, serialized handlers, explicit failure states, unknown exceptions, terminal outcomes, pending reconciliation, and one dispatch across two SQLite processes.

`check:release` proves the stable script names, port/coordinator artifacts, and composition boundary are present.
