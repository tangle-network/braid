# Conversation navigation

## Job

Conversation navigation lets the user create, import, rename, archive, delete, switch, branch, and clone without confusing history identity.

## Best simple implementation

Use one searchable conversation surface and one searchable branch surface.

Carry conversation and branch identifiers in every action.

Use small confirmation or rename panels for destructive or textual mutations.

Keep branching inside the conversation journal and keep workspace forking in its separate preview workflow.

Do not infer a branch from the focused run when an explicit branch target is available.

## Component map

| Component | Responsibility |
| --- | --- |
| `ConversationOverlayController` | Open and refresh conversation and branch selectors. |
| `ConversationOverlayActions` | Dispatch typed create, import, rename, archive, delete, branch, clone, and switch actions. |
| `ConversationConfirmation` | Confirm one named destructive or durable mutation. |
| `ConversationRename` | Validate and submit one bounded title edit. |

## Identity and state

A conversation owns a branch graph.

A branch identifies one path through that graph.

A turn identifies one user input and its resulting activity.

A run identifies one admitted execution of a turn.

Navigation changes selection and focus but never rewrites those identities.

An active run can continue on a background branch after the user selects another branch.

## Inputs and outputs

Selectors receive immutable conversation and branch summaries with stable identifiers.

Actions emit typed intents with the selected identifiers and a stable operation identifier.

The application returns accepted, unavailable, conflict, or error outcomes.

An accepted action refreshes from canonical state instead of editing selector rows locally.

## Algorithms

The selector preserves its row by stable identifier across refreshes.

Branch creation records an explicit source point and creates a new branch in the same conversation.

Clone copies the selected branch history into a new conversation without claiming provider continuity.

Deletion remains unavailable while canonical constraints require the entity.

Same-operation replay returns the recorded result.

Changed input under the same operation identifier returns a conflict.

## Failure and safety

Unknown conversation or branch identifiers fail before mutation.

Destructive actions require a confirmation that names the target.

Imported content passes size, schema, path, and terminal-sanitization checks.

Conversation titles cannot carry terminal control sequences.

Deleting history never deletes an environment, provider session, or credential by implication.

## Performance

Selectors consume bounded summaries rather than full transcripts.

Filtering and refresh remain independent of stored message volume.

## Proof

Reducer and storage tests cover idempotency, restart, migration, graph invariants, import, and delete constraints.

Keyboard tests cover open, filter, switch, branch, rename, cancel, and focus restoration.

## Non-goals

Conversation navigation does not perform workspace fork or native provider continuation.

It does not stop a background run merely because selection changed.
