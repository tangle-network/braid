# ADR 002: Keep execution and bidirectional control in shared packages

Status: accepted

Date: 2026-08-01

## Context

`agent-runtime` already normalizes execution across chat, executor, and sandbox paths.

`agent-interface` already defines portable profiles, provider capabilities, stream events, and generalized interactions.

CLI Bridge already owns local runner processes, exact profile materialization, durable run identifiers, replay, and cancellation.

The Tangle provider already owns cloud sandbox sessions, replay, workspace operations, checkpoints, and forks.

The current shared path does not yet expose a complete response route from a terminal interaction back to a live environment or runtime run.

The current runtime stream also drops some canonical interface events, and the runtime supervisor monitor writes a cancellation request that no runtime reader consumes.

## Decision

The missing interaction, replay-preserving event, and durable control APIs will be added to `agent-interface`, `agent-runtime`, CLI Bridge, and the provider packages before Braid depends on them.

Braid will consume those APIs through narrow ports and will not define a competing transport protocol.

Braid may define internal intents and immutable view models, but those types cannot become provider contracts.

The runtime remains responsible for lifecycle, execution admission, event normalization, stop behavior, and supervisor control.

Providers remain responsible for native sessions, transport replay, workspaces, and profile materialization.

Providers also own exact lookup for remote work accepted before Braid commits its control reference.

## Consequences

Interactive permission prompts work the same way for local and cloud runs.

Headless Braid and terminal Braid drive the same shared run instead of using separate execution paths.

Upstream package releases must precede the Braid integration release.

Braid can capability-disable a feature when a provider has not implemented the new contract.

This decision adds work to the shared packages, but it prevents every client from inventing incompatible interaction and cancellation semantics.

## Rejected alternatives

Posting an ad hoc Braid response endpoint to CLI Bridge was rejected because Tangle cloud and future clients would require another translation.

Writing directly into `.agent/supervisor` was rejected because the file layout is runtime-owned and its current cancel request has no consumer.

Auto-approving prompts in headless runners was rejected because it silently changes the user's permission policy.

Treating disconnect as cancel was rejected because current CLI Bridge semantics intentionally detach a durable run.

## Verification

The upstream checks `UP-01` through `UP-14` must pass against published package versions before Braid's interaction, context, fork, and supervisor work can be marked complete.
