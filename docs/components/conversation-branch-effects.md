# Conversation branch effects

`ConversationBranches` owns planning and `conversation-branch-effects.ts` owns provider effects.

The implementation uses the published `@tangle-network/agent-interface` contracts as the single cross-runner and workspace-fork boundary.

## Inputs and outputs

The planner reads immutable Braid state, the selected branch boundary, and the execution port capabilities.

It returns a digest-bound preview that names the source run, destination, context plan, placement, and allowed action.

Execution accepts only the matching preview digest and returns the durable destination branch.

Cleanup accepts stable checkpoint and destination-environment identifiers and returns an exact per-resource outcome.

## State and invariants

Cross-runner transfer requires a recorded source environment, an exact canonical history plan, and a provider transfer method.

Workspace fork requires checkpoint, fork, lookup, retry-safe, and cleanup capabilities from both the selected run and execution port.

Every provider request uses a stable operation or idempotency identifier and validates the exact response matcher before persistence.

Destination environments receive deterministic Braid identifiers and must differ from the provider source environment.

The journal records only compact redacted transfer receipts, provider references, operation digests, graph edges, and immutable view-model data.

The provider remains authoritative for live sessions, checkpoints, forks, and cleanup status.

## Performance and tests

Canonical conversion caps 1,024 messages and the agent-interface one-megabyte digest material limit.

Legacy view context remains bounded by the existing twenty-thousand-message and two-megabyte limits.

Provider lookups run before creation calls, so restart recovery does not repeat successful checkpoint, fork, or transfer effects.

`test/conversation-branch-effects.test.ts` proves canonical handoff, restart replay, exact provider requests, destination isolation, cleanup, and unavailable capability behavior.

The unit, contract, and security suites cover reducer replay, durable operations, redaction, and public-surface boundaries.

## Non-goals

This component does not parse provider-native output, launch runners, invent provider capabilities, or copy provider-private state.

It does not promise cross-runner continuation when the provider cannot create a fresh session from the canonical plan.

It does not expose credential values or place secrets in profiles, journal records, snapshots, logs, or terminal output.
