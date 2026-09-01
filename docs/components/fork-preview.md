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

Confirmation emits the plan digest and a stable operation identifier.

Cancellation emits no external mutation.

## Fork kinds

A conversation branch creates another history path in the same conversation.

A clone creates another Braid conversation from visible history.

A workspace fork creates a destination environment from a checkpoint.

A cross-runner fork starts a new run from portable history and workspace state without claiming native provider continuity.

The preview names the selected kind and its omitted state.

## Algorithms

Planning asks the selected provider for current capabilities.

Planning freezes source identity and the latest eligible checkpoint.

Execution recomputes the plan digest and refuses any changed source or destination.

Execution uses one stable idempotency key for destination creation.

Restart first looks up that key before another external mutation.

Successful execution records destination identity and independent cleanup ownership.

## Failure and safety

Unsupported checkpoint or fork capability disables confirmation with one reason.

A source change after preview returns a conflict and requires a new preview.

An unknown external result remains unknown until lookup resolves it.

Cleanup targets only the destination identifiers returned by the provider.

Credentials and checkpoint contents never appear in the view or capture.

## Performance

The preview renders a bounded list of facts and warnings.

Workspace data moves through the provider or Sandbox implementation, not through terminal memory.

## Proof

Tests cover branch, clone, workspace fork, cross-runner fork, changed-plan conflict, restart lookup, independent mutation, source preservation, cancellation, and cleanup.

The terminal recording reviews and executes a real plan through the same panel.

## Non-goals

The preview does not promise provider-session continuity across runners.

It does not display raw checkpoint data or provider-private fields.
