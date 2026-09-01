# Workspace branching

## Job

Workspace branching creates an isolated provider environment from an exact source run and records every cleanup result.

It supports checkpoint, lookup, fork, restart replay, destination mutation, source preservation, and resource cleanup.

## Workspace request boundary

The startup `WorkspaceRequest` selects a provider-neutral remote workspace for a run.

The local Braid `workspaceRoot` remains separate and never becomes the provider workspace cwd.

Admission freezes the request inside `receipt.requested` and includes it in the exact request digest.

Retained and ephemeral Tangle starts receive that frozen request through the runtime environment boundary.

Recovery reads the request from the receipt and does not infer it from current setup configuration.

Legacy receipts without a request replay with provider defaults.

Branching records source environment identity separately from startup workspace selection.

Provider-native options remain outside Braid persistence and branch records.

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

The selected `tangle-sandbox` connection carries an immutable, public Nitro trust policy.

The policy requires non-empty SHA-256 measurement and policy identifier allowlists.

The policy also sets a bounded maximum age for signed and provider timestamps.

The startup configuration persists this policy with the connection record.

Credentials, quotes, certificates, and executable module paths never enter that record.

The adapter pins the AWS Nitro Enclaves Root-G1 certificate and checks its SHA-256 fingerprint at construction.

The adapter parses the provider report and the CBOR/COSE document through the published Tangle attestation package.

The adapter verifies the certificate chain, COSE signature, exact nonce, raw measurement, signed-document age, and bindings.

The adapter derives `providerKeyId` from the verified leaf certificate fingerprint.

The adapter derives `providerSignature` from the verified COSE signature bytes.

The canonical replay path decodes the persisted quote and repeats every check.

Replay also requires the persisted provider key and signature to match the derived identities.

Braid marks `confidentialVerified` only after this canonical verifier accepts the complete attestation.

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

`LIVE-10` requires the typed Nitro policy, a valid attestation, missing-attestation rejection, wrong-nonce rejection, wrong-measurement rejection, and exact cleanup.

The built-in proofs run through Braid application and connection adapters.

They do not import the Sandbox SDK or call Sandbox methods directly.

Set `BRAID_TANGLE_CONFIDENTIAL_MEASUREMENTS` to the accepted canonical `sha256:` measurements.

Set `BRAID_TANGLE_CONFIDENTIAL_POLICY_IDS` to the accepted policy identifiers.

Set `BRAID_TANGLE_CONFIDENTIAL_POLICY_ID` to the selected identifier from that allowlist.

Set `BRAID_TANGLE_CONFIDENTIAL_MAX_AGE_SECONDS` to the bounded freshness limit.

LIVE-10 persists these values as the selected connection's typed trust policy.

The production composition constructs the same Nitro verifier factory for provider admission and replay.

No arbitrary verifier module is loaded or executed.

Missing credentials, deployment capability, or verifier configuration returns typed unavailable evidence.

Configured provider failures remain failed and never become simulated passes.

## Tests

`test/conversation-branch-effects.test.ts` proves exact requests, provider reconstruction, restart cleanup, idempotent replay, and source protection.

`test/tangle-workspace-proof.test.mjs` proves the confidential negative checks reject nonce, measurement, and self-echo mutations.

`test/nitro-confidential-attestation.test.ts` proves COSE verification, identity derivation, mutation rejection, freshness, persistence, migration, replay, and secret-free snapshots.

The protected live matrix validates both receipts against the public evidence schema.

## Non-goals

This component does not parse Sandbox output, persist provider-private state, or infer attestation trust from request fields.

It does not create a workspace fork when the provider cannot prove lookup and cleanup support.
