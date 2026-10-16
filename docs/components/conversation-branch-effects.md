# Conversation branch effects

`ConversationBranches` owns planning and `conversation-branch-effects.ts` owns provider effects.

The implementation uses the published `@tangle-network/agent-interface` contracts as the single cross-runner and workspace-fork boundary.

## Best simple implementation

Plan every branch effect from immutable Braid state and return one digest-bound preview before external work.

Execute portable transfer, checkpoint, fork, lookup, and cleanup only through the matching published capability.

Keep provider resources authoritative outside Braid and persist only exact redacted receipts and graph identities.

Use one stable operation identity for retry and reject a response that does not match the planned source and destination.

An explicit destination connection is bound into the fork plan with its full non-secret configuration digest.
Changing that connection after preview invalidates the plan before transfer.
The destination branch keeps that connection after journal replay; the source branch retains its own connection.
Provider-neutral context routing validates the canonical request before resolving credentials and validates every lookup or transfer result before returning it to the application.

An explicit destination profile is bound into the fork plan with its canonical digest.
Execution refuses a changed or missing profile before reserving the operation, then commits one deterministic profile snapshot after the transfer is accepted and before the branch is created.
The destination branch carries that snapshot through journal replay, and `effectiveRunConfiguration` uses it in place of the selected profile.

Fork planning reads the destination provider's transfer capability asynchronously before confirmation.
It creates no environment or session.
A source or destination change during that read invalidates the preview.

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

`test/profile-fork.test.ts` checks profile-bound forks through real profile files, keyboard input, and encrypted SQLite reopen. `test/cli-bridge-context-transfer.test.ts` checks the published Runtime/provider context-transfer path over real HTTP. The protected live matrix owns provider workspace creation and cleanup proof.

The unit, contract, and security suites cover reducer replay, durable operations, redaction, and public-surface boundaries.

## Non-goals

This component does not parse provider-native output, launch runners, invent provider capabilities, or copy provider-private state.

It does not promise cross-runner continuation when the provider cannot create a fresh session from the canonical plan.

It does not expose credential values or place secrets in profiles, journal records, snapshots, logs, or terminal output.
