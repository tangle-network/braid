# Terminal shell and chrome

## Job

The terminal shell keeps the transcript, composer, identity, status, focus, and terminal lifecycle coherent.

It is the stable frame around every Braid workflow.

## Best simple implementation

Use one `BraidTerminalApp` coordinator and one `BraidShell` layout root.

Feed both from the immutable `BraidViewModel` through `ApplicationUiController`.

Keep terminal mode ownership in `AlternateScreenTerminal` and the application start, suspend, resume, and stop paths.

Keep status and identity rendering in the fixed-height `TerminalChrome`.

Route keyboard input through `TerminalInputController` and commands through `TerminalCommandController`.

Do not let a panel call an application port directly.

## Component map

| Component | Responsibility |
| --- | --- |
| `BraidTerminalApp` | Compose the shell, controllers, overlays, subscriptions, terminal policy, and lifecycle. |
| `BraidShell` | Allocate rows between transcript, composer, and fixed chrome. |
| `TerminalChrome` | Render bounded identity, status, navigation, work, and measured usage rows. |
| `TerminalInputController` | Interpret global keys before forwarding text to the focused component. |
| `TerminalCommandController` | Resolve a command to one typed intent or a local presentation action. |
| `ApplicationUiController` | Project application state and dispatch typed intents. |
| `AlternateScreenTerminal` | Enter and restore the real terminal mode without leaking control state. |

## Inputs and outputs

The shell receives a controller, TUI instance, theme, workspace, operation-id source, keymap, and optional native actions.

The controller supplies immutable view models and accepts typed intents.

The shell outputs terminal rows and never returns provider-native data.

User actions become typed intents with explicit run, conversation, branch, interaction, or worker identifiers.

## State and focus

The application owns only presentation state such as the open modal, quit arming, composer mode, and saved draft.

Durable conversations, runs, interactions, and operations remain in the application core.

The modal coordinator owns focus while a modal is visible.

Closing the top modal restores the previous valid focus target.

Suspension releases the local terminal while preserving the controller subscription and application state.

## Responsive behavior

The shell computes one layout from the current columns and rows on every render.

The transcript receives all rows left after chrome and composer allocation.

Narrow chrome keeps status and the route to activity.

Standard chrome adds navigation and a small Work Strip.

Wide chrome adds execution limits and measured usage only when those values are real.

No layout creates a permanent side pane.

## Failure and safety

Terminal cleanup must run after normal exit, signal exit, startup failure, stream failure, and test interruption.

The signal lifecycle queues frame requests and atomically replaces the latest signal frame during repeated captures.

Unknown capabilities render through `UnavailablePanel` with the provider reason.

All title, status, identity, and notification text is sanitized before terminal output.

The shell never renders credential values or secret-designated interaction answers.

## Performance

One frame subscription coalesces stream deltas at the configured frame interval.

Rendering remains proportional to the bounded visible transcript and visible Work Strip.

The shell does not scan the journal or provider state during render.

## Proof

PTY tests prove startup, keyboard routing, suspend, resume, shutdown, and terminal restoration.

Virtual-terminal tests prove exact rows and focus behavior.

Captures prove the shell at 40×12, 80×24, 120×40, and 200×60.

## Non-goals

The shell does not own agent execution, replay, persistence, profiles, or provider sessions.

The shell does not infer a runner or model from display text.
