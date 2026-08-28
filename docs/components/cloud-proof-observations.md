# Cloud proof observations

## Purpose

The cloud proof observations component proves that Braid controls the provider resource it reports.

It covers LIVE-07 retained runs and LIVE-08 native interactive runs.

## Ownership

The Braid proof scripts own evidence collection and receipt validation.

The Sandbox provider owns workspace files, terminal state, resource usage, and account identity.

Braid does not infer provider execution from assistant text or local terminal echo.

## Best simple implementation

The proof collects provider readback through the authenticated Sandbox client and validates it before receipt creation.

## Inputs and outputs

The proof receives one authenticated Sandbox client, one Braid control reference, and generated workspace paths.

The provider readback returns a resource identity, file bytes, terminal metadata, usage samples, and account identity.

The public receipt contains digests, statuses, counts, paths, and timings without credential values or secret-designated content.

## State and invariants

The execution-attempt ledger is append-only and must contain exactly one expected line after replay and reconnect.

Input and reconnect checks pass only after the provider workspace contains the expected bytes.

Cleanup enumerates every Braid-owned retained resource for the exact provider session and rejects duplicate ownership.

The account identity must remain stable before execution and after cleanup.

The active-resource delta must be observed and must equal zero after cleanup.

Telemetry and spend fields must be observed or explicitly unavailable, and missing fields fail the proof.

## Performance

Workspace reads use one exact resource lookup per polling attempt and bounded proof paths.

Cleanup uses paginated provider listing and bounded deletion retries for each owned resource.

Provider-bound mutation evidence stores digests instead of raw file bytes, and diagnostics remain bounded.

## Tests

Focused tests reject local-only input, duplicate owned resources, duplicate execution lines, and missing telemetry.

The complete local verification command covers receipt validation, replay, cancellation, terminal behavior, and projections.

## Non-goals

This component does not implement a runner, terminal protocol, provider session store, or billing system.

This component does not claim provider behavior when public observation or cleanup evidence is unavailable.
