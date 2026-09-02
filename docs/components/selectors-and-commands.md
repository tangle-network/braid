# Selectors and commands

## Job

Selectors provide one searchable keyboard contract for commands, profiles, conversations, branches, runs, workers, analyses, and rules.

## Best simple implementation

Use `SearchableSelector` as the only generic list interaction.

Supply immutable items with stable values, safe labels, optional descriptions, and declared actions.

Build the command palette as a selector over the canonical command registry.

Build autocomplete from the same registry and current capability map.

Do not maintain a second command list inside the terminal.

Keep TUI and headless dispatch on the same application command path after their surface-specific parsing.

## Component map

| Component | Responsibility |
| --- | --- |
| `SearchableSelector` | Filter, navigate, select, cancel, and route declared row actions. |
| `CommandPalette` | Present supported commands from the canonical registry. |
| `DynamicAutocompleteProvider` | Combine command completion with bounded workspace path completion. |
| `GuardedAutocompleteProvider` | Ignore stale completion results after the input context changes. |

## Inputs and outputs

A selector receives a title, immutable items, theme, visible-row limit, footer, and callbacks.

Selection emits the item's stable value rather than its display label.

Command selection emits the same command path that typed slash input uses.

Disabled commands remain visible with the exact capability reason.

The fork command usage is `/fork [message] [--workspace | --runner name [--provider name]] [--confidential JSON]`.

The TUI accepts one confidential JSON request with either `--confidential JSON` or `--confidential=JSON` and validates it with the shared schema.

Headless `plan_fork` and `execute_fork` accept the same request as a `confidential` record.

`execute_fork` also requires the reviewed `planDigest` and a stable operation identifier.

## Interaction contract

Typing filters safe label and description text.

Arrow keys move one row.

Page keys move one viewport.

Enter selects the current row.

Escape or left closes the surface without changing application state.

Declared action keys operate on the current row and never infer an entity from display order.

## State

Query text, selected index, and scroll offset are local presentation state.

The source collection and capability decisions remain in the view model.

Each update keeps selection by stable item value when possible.

An empty or no-match state is explicit and still accepts cancel input.

## Failure and safety

Autocomplete is disabled during bracketed paste and other unsafe editor states.

Late filesystem completion cannot replace results for a newer query.

Paths stay under the configured workspace root.

Labels, descriptions, paths, and capability reasons are sanitized before display.

Confidential request fields are not copied into selector labels or the TUI preview; the preview shows only the requested TEE and sealed requirement.

Invalid confidential input returns a bounded generic error without echoing the request contents.

The command selector does not infer confidential support from the request; planning and execution recheck provider capabilities and the external attestation verifier.

The installed Tangle provider capability path keeps confidential branching unavailable when snapshot-restore inputs are absent; this is package behavior, not a live observation.

Ordinary workspace branching remains a separate capability.

## Performance

Filtering operates over bounded projected collections.

Only visible rows render.

Dynamic filesystem completion debounces input and discards stale work.

## Proof

Tests cover Unicode filtering, narrow widths, empty lists, no matches, paging, declared actions, late autocomplete, paste, disabled commands, confidential TUI parsing, and headless schema validation.

The keyboard recording opens the palette, filters an action, selects it, and returns focus.

## Non-goals

Selectors do not fetch provider capabilities or mutate entities.

Autocomplete does not search outside the workspace or execute a command.
