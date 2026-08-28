# Modal coordination

## Job

Modal coordination shows temporary decision and detail surfaces without corrupting focus, drafts, or the underlying transcript.

## Best simple implementation

Use one `ModalCoordinator` as the stack owner for every overlay.

Use `TerminalOverlayController` to translate product actions into modal workflows.

Use `TerminalSurfaceOverlays` to construct full-viewport activity, graph, analysis, comparison, fork, profile, and help surfaces.

Do not let a component add itself directly to the TUI root.

## Component map

| Component | Responsibility |
| --- | --- |
| `ModalCoordinator` | Open, replace, close, focus, and size the modal stack. |
| `TerminalOverlayController` | Coordinate conversation, connection, automation, configuration, and surface workflows. |
| `TerminalSurfaceOverlays` | Build product surfaces from the current immutable view. |

## Inputs and outputs

The coordinator receives a focusable component and bounded width, height, and anchor options.

The overlay controllers receive the current view, operation-id source, typed dispatch function, and render request.

An overlay emits typed intents or local navigation events.

Closing an overlay emits no product mutation unless the user accepted an explicit action.

## Focus and lifecycle

The coordinator keeps an ordered stack and focuses only its top entry.

Opening the first modal hides the composer from rendering and input.

Closing the top modal restores the next modal or the composer.

Replacing a workflow step keeps one stack position and prevents hidden focusable children.

Closing the application invalidates outstanding overlay generations so late asynchronous results cannot reopen a surface.

## Responsive behavior

Full-viewport browsers use the available terminal size.

Decision panels use bounded percentages with a minimum usable width.

At 40×12, the panel keeps its title, current decision, and cancel route.

At larger sizes, the same component reveals descriptions and details.

## Failure and safety

An asynchronous load failure replaces the pending view with one safe unavailable panel.

Late results from a closed generation are ignored.

Focus restoration does not submit the editor or replay the closing key.

Every modal body receives sanitized view-model text.

## Performance

Only the top modal handles input.

Hidden surfaces do not poll or render.

Runtime-backed surfaces subscribe through one controller and stop refresh when closed.

## Proof

Tests cover nested confirmation, replacement, escape, left navigation, focus restoration, resize, late results, and close cleanup.

Virtual-terminal fixtures cover every full-viewport surface at the four required sizes.

## Non-goals

The coordinator does not own workflow state, provider calls, or durable decisions.

An overlay does not become a permanent navigation region.
