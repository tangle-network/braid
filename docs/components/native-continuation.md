# Native continuation

## Purpose

Native continuation adds one turn to the exact runner-owned session at the current branch tip.

It preserves provider-native context without copying hidden history into Braid.

## Ownership

`agent-interface` owns the boundary proof, exact run reference, request digest, and acknowledgement schemas.

`agent-runtime` owns exact reconnection, boundary observation, idempotent continuation, and result validation.

Braid owns branch-tip selection, capability presentation, durable admission, restart recovery, and terminal dispatch.

Providers own the live session and must advertise both atomic boundary checks and request idempotency.

## Best simple implementation

Braid selects only the completed run at the open branch tip with the same profile and connection.

The run must contain an exact six-field provider control reference.

The environment capability document must advertise session continuation, an atomic boundary, and request idempotency.

Braid reconnects the exact source run and asks Runtime for a canonical boundary proof.

Braid stores that proof in the destination run receipt before dispatch.

Runtime binds one stable operation identifier to the exact turn, source run, and expected boundary.

Runtime calls `continueNative` and accepts only an accepted or replayed acknowledgement.

The returned run must stay in the same provider, environment, and provider session.

This path does not create a new environment, parse runner output, or reconstruct provider history.

## Restart behavior

A crash after durable admission leaves the destination run in a recoverable state.

Restart rebuilds the same continuation input from the stored receipt.

Runtime repeats the same request digest and requires the provider to return the original result.

The replay path never falls back to a generic send when an exact boundary check fails.

## Tangle recovery

Tangle lookup scans bounded personal sandbox pages and matches the retained environment metadata.

It then reads the exact session status and validates the provider, environment, session, and execution identifiers.

An environment-phase crash reuses the recorded environment and execution identity.

Duplicate environments, changed identity, missing capabilities, and malformed control references fail closed.

## User interface

The terminal routes an ordinary send through native continuation when the current branch tip qualifies.

Generic providers keep the ordinary send path.

Stale runs, incomplete runs, profile changes, connection changes, and unsupported providers do not expose continuation.

## Verification

Focused tests cover accepted continuation, replay after restart, exact control binding, and same-session advancement.

They also cover cross-process Tangle lookup, environment-admission recovery, stale tips, incomplete tips, and boundary failure.

The complete Braid test suite remains the final regression check before integration.
