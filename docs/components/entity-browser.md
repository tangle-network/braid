# Entity browser and details

## Job

The entity browser supplies one list-and-details interaction for complex collections without adding permanent panes to the main screen.

## Best simple implementation

Use `EntityBrowser` as the shared full-viewport list, filter, selection, and detail layout.

Use `DetailsViewPanel` for a standalone immutable detail document.

Adapt activity, graph, analysis, and comparison records into the same row and detail contracts.

Do not specialize keyboard behavior for each entity kind.

## Component map

| Component | Responsibility |
| --- | --- |
| `EntityBrowser` | Own query, selected row, viewport, details visibility, and common keys. |
| `DetailsViewPanel` | Render one bounded detail document. |

## Inputs and outputs

Rows contain stable values, safe labels, summaries, status, and optional action metadata.

Details contain a title and bounded lines.

Selection emits the stable row value.

Back closes details before it closes the browser.

## Responsive behavior

At narrow widths, the browser shows either the list or details.

At standard widths, it prioritizes the list and opens details as the next surface.

At wide widths, it may show list and details together when both remain readable.

The keyboard contract stays identical across layouts.

## State

Query, selection, offset, and detail visibility are local state.

Entity facts and actions remain immutable inputs.

Refresh keeps selection by stable value and clamps the viewport.

An entity removed by refresh selects the nearest valid row.

## Failure and safety

An empty collection renders one explicit empty state.

Invalid details render no guessed fields.

Every label and detail line is sanitized and width-bounded.

Actions target identifiers and never row indexes.

## Performance

Filtering uses the bounded projected rows.

Only the active viewport and selected detail render.

The component performs no I/O or provider polling.

## Proof

Shared tests run the same keyboard cases through activity, graph, analysis, and comparison adapters.

Resize tests prove selection and detail continuity across all layout modes.

## Non-goals

The browser does not own entity state, refresh intervals, or mutations.

It does not introduce a dashboard beside the transcript.
