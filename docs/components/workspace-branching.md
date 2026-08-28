# Workspace branching

## Job

Workspace branching creates an isolated provider environment from an exact source run and records every cleanup result.

It supports checkpoint, lookup, fork, restart replay, destination mutation, source preservation, and resource cleanup.

## Component map

| Component | Responsibility |
| --- | --- |
| `ConversationBranches` | Build and validate the digest-bound workspace plan. |
| `conversation-branch-effects.ts` | Execute provider checkpoint and fork effects, then record Braid identities. |
| `AgentWorkspaceBranchingProvider` | Reconstruct a fresh source-scoped operation handle after restart. |
| `createTangleWorkspaceBranchingProvider` | Resolve Tangle credentials and delegate exact Sandbox operations. |
| `tangle-workspace-proof.mjs` | Run the protected LIVE-09 and LIVE-10 production proofs. |

## Best simple implementation

Braid stores the source control reference, operation digest, provider checkpoint identity, and provider environment identity.

Braid stores no live provider environment handle in durable state.

The provider exposes `forEnvironment(sourceEnvironmentId)` and creates a fresh operation handle for each recovery path.

The Tangle adapter owns Sandbox calls for checkpoint, lookup, delete, fork, lookup, and destroy.

The application validates every response against the canonical request digest before it records a resource.

The application calls lookup before creation, so a retry cannot create a second checkpoint or fork.

Cleanup names the resource kind, provider, target identifier, and cleanup request digest.

The application refuses source cleanup when the target is the source environment.

## Confidential placement

The request records `requested` placement separately from provider evidence.

The Tangle adapter calls `getTeeAttestation` on the forked Sandbox child.

An operator-supplied verifier must validate the raw provider quote, provider key, nonce, and measurement.

The adapter rejects a missing key, a copied quote, an invalid nonce, or an untrusted measurement.

Braid marks `confidentialVerified` only after the canonical external verifier accepts the complete attestation.

The request and attestation remain unverified when either verifier or attestation evidence is absent.

## Restart and cleanup flow

1. Plan from one immutable source branch, run, control reference, and environment.
2. Checkpoint through the fresh source-scoped provider handle.
3. Fork through the same handle with a separate idempotency key.
4. Record the returned destination environment and graph edge.
5. Reopen Braid and replay the same operation digest.
6. Reconstruct the provider handle from the persisted source environment identifier.
7. Look up both resources before cleanup.
8. Delete the checkpoint and destroy the destination environment with separate requests.
9. Verify the source contents and destroy the source environment through a fresh provider environment handle.

## Production proof

`LIVE-09` requires source materialization, checkpoint lookup, fork lookup, restart replay, independent destination mutation, unchanged source content, and exact cleanup.

`LIVE-10` requires a configured external verifier, a valid attestation, missing-attestation rejection, wrong-nonce rejection, wrong-measurement rejection, and exact cleanup.

The built-in proofs run through Braid application and connection adapters.

They do not import the Sandbox SDK or call Sandbox methods directly.

Set `BRAID_TANGLE_TEE_VERIFIER_MODULE` to an absolute or repository-relative module for `LIVE-10`.

That module must export `verifyTeeAttestation(input)` and `verifyConfidentialAttestation(attestation, expected)`.

The first function returns `{ providerKeyId, providerSignature, measurement? }` only after raw quote verification.

The second function returns `true` only after canonical nonce, measurement, policy, and provider-key checks.

Missing credentials, deployment capability, or verifier configuration returns typed unavailable evidence.

Configured provider failures remain failed and never become simulated passes.

## Tests

`test/conversation-branch-effects.test.ts` proves exact requests, provider reconstruction, restart cleanup, idempotent replay, and source protection.

`test/tangle-workspace-proof.test.mjs` proves the confidential negative checks reject nonce, measurement, and self-echo mutations.

The protected live matrix validates both receipts against the public evidence schema.

## Non-goals

This component does not parse Sandbox output, persist provider-private state, or infer attestation trust from request fields.

It does not create a workspace fork when the provider cannot prove lookup and cleanup support.
