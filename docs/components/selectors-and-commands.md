# Selectors and commands

## Job

Selectors provide one searchable keyboard contract for commands, profiles, conversations, branches, runs, workers, analyses, and rules.

## Best simple implementation

Use `SearchableSelector` as the only generic list interaction.

Supply immutable items with stable values, safe labels, optional descriptions, and declared actions.

Build the command palette as a selector over the canonical command registry.

Build autocomplete from the same registry and current capability map.

Do not maintain a second command list inside the terminal.

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

## Performance

Filtering operates over bounded projected collections.

Only visible rows render.

Dynamic filesystem completion debounces input and discards stale work.

## Proof

Tests cover Unicode filtering, narrow widths, empty lists, no matches, paging, declared actions, late autocomplete, paste, and disabled commands.

The keyboard recording opens the palette, filters an action, selects it, and returns focus.

## Non-goals

Selectors do not fetch provider capabilities or mutate entities.

Autocomplete does not search outside the workspace or execute a command.
