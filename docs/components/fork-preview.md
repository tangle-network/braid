# Fork preview

## Job

The fork preview explains the exact source boundary, destination, copied state, omitted state, capabilities, and cleanup plan before a fork mutates an external environment.

## Best simple implementation

Project the canonical fork plan into one immutable `ForkPreviewView`.

Render that view in `ForkPreviewPanel` without re-deriving capability or identity decisions.

Execute only the plan digest the user reviewed.

Use the shared runtime and provider fork ports for external work.

Do not copy provider sessions, checkpoints, or workspaces inside the terminal client.

## Component map

| Component | Responsibility |
| --- | --- |
| `ForkPreviewPanel` | Present source, destination, boundaries, warnings, and confirm or cancel actions. |

The application fork planner owns plan creation and execution.

The provider owns the environment and checkpoint operations.

## Inputs and outputs

The panel receives a frozen plan with source conversation, branch, turn, run, provider session, environment, checkpoint, destination profile, destination connection, and destination workspace.

Unknown values remain explicit.

The TUI accepts one canonical confidential request as a JSON value after `--confidential` or `--confidential=`.

The request uses the strict `ConfidentialExecutionRequestSchema` fields `requested`, `tee`, `sealed`, `nonce`, `policy`, and `profileDigest`.

Duplicate flags, missing JSON, or invalid fields fail before planning.

Headless `plan_fork` and `execute_fork` accept the same `confidential` record and use the same parser.

The application validates the request before planning and includes the normalized request in the plan digest.

Confirmation emits the plan digest and a stable operation identifier.

Cancellation emits no external mutation.

## Fork kinds

A conversation branch creates another history path in the same conversation.

A clone creates another Braid conversation from visible history.

A workspace fork creates a destination environment from a checkpoint.

A cross-runner fork starts a new run from portable history and workspace state without claiming native provider continuity.

Confidential placement is an option on a workspace fork, not a separate fork kind.

The preview names the selected kind and its omitted state.

## Confidential availability

A requested confidential fork is allowed only when the selected completed run reports workspace branching, confidential branching, and confidential environment support, and the execution port provides an external attestation verifier.

Braid does not downgrade a confidential request to an ordinary workspace fork when any requirement is absent.

The installed Tangle provider `1.1.4` with Sandbox `0.37.0` narrows `branching.confidential` to `false` when the deployed job lacks snapshot-restore inputs.

This is installed-provider behavior, not a live capability observation.

The same provider path refuses a new confidential workspace fork before child creation until those inputs are available.

Deterministic tests can supply the capability and verifier ports to exercise the success path, but they are not live provider evidence.

## Algorithms

Planning asks the selected provider for current capabilities.

Planning freezes source identity and the latest eligible checkpoint.

The plan keeps Braid conversation, branch, turn, run, and operation identifiers separate from provider session, environment, and checkpoint identifiers.

Execution recomputes the plan digest and refuses any changed source, destination, or confidential request.

Execution derives stable idempotency keys for checkpoint and destination creation from the operation identifier.

Restart first looks up each key before another external mutation.

Successful execution records destination identity and independent cleanup ownership.

## Failure and safety

Unsupported checkpoint or fork capability disables confirmation with one reason.

A confidential request also requires workspace branching, confidential environment support, and an attestation verifier.

The preview shows only the requested TEE and sealed requirement; it never renders nonce, policy, or profile-digest values.

The request is not proof of placement.

`confidentialVerified` becomes true only after the canonical attestation verifier accepts the provider evidence and its bindings.

Missing, mismatched, copied, or explicitly unverified attestation identity remains unverified.

A source change after preview returns a conflict and requires a new preview.

An unknown external result remains unknown until lookup resolves it.

Cleanup targets only the destination identifiers returned by the provider.

Credentials and checkpoint contents never appear in the view or capture.

## Performance

The preview renders a bounded list of facts and warnings.

Workspace data moves through the provider or Sandbox implementation, not through terminal memory.

## Proof

`test/conversation-branch-effects.test.ts` covers branch, clone, workspace fork, cross-runner fork, changed-plan conflict, restart lookup, independent mutation, source preservation, cancellation, cleanup, confidential capability gates, canonical attestation verification, and request propagation.

`test/rpc.test.ts` covers the headless confidential schema and rejects unknown request fields.

`test/tui-autocomplete.test.ts` and `test/tui-core-workflows.test.ts` cover the TUI command path and safe preview rendering.

The packed keyboard flow exercises the same panel with local fixtures; it is not live provider proof.

## Non-goals

The preview does not promise provider-session continuity across runners.

It does not display raw checkpoint data or provider-private fields.
