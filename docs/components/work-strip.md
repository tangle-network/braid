# Work Strip

## Job

The Work Strip makes multiple active, queued, waiting, or detached runs discoverable without taking space from the transcript.

It appears only when at least two work items require attention.

It provides a compact route to switch focus and inspect the full activity surface.

## Best simple implementation

Project one immutable row for each non-terminal run or actionable queue entry.

Show the strip only when at least two rows exist, and move full selection and details into Activity.

Derive the `focus` label from the exact focused run while leaving conversation selection independent.

Emit typed run intents and let the application own every control effect.

## Ownership

`workStripFor` in `src/adapters/tui/ui-projection.ts` converts canonical runs and queued entries into immutable work item views.

`TerminalChrome` in `src/views/tui/terminal-chrome.ts` renders the strip beside stable status chrome.

`ActivityBrowser` and `EntityBrowser` provide the searchable full-viewport selector at narrow sizes.

`focus-run` is the typed intent that transfers focus without changing run ownership.

The application owns control and interaction dispatch after the focused run changes.

## Inputs

The projection receives immutable Braid state with runs, queued entries, branch identifiers, receipts, capabilities, interactions, and focus.

The renderer receives a Braid view model, terminal width, terminal context mode, and theme.

The activity selector receives keyboard input and a bounded list of run rows.

## Outputs and intents

Each item exposes branch, state, runner, model, pending interaction count, a `focus` or `work` label, and switch, ask, steer, and cancel actions.

Each activity run row carries its run identifier for explicit focus dispatch.

The narrow strip emits a visible `/activity` route instead of opening a permanent side pane.

The activity browser emits `focus-run` when the selected run row is opened.

The focused run remains separate from the selected conversation branch so background controls target the intended run.

## State

The strip includes all non-terminal runs and all queued entries with a known source run.

Detached runs remain visible so the operator can distinguish remote work from local work.

Queued entries remain separate items even when they share a source run.

An item labels the controlled run as `focus` and every other row as `work`.

The label comes from `focusedRunId` and never from row order or the selected conversation.

An item reports runner and model from the admitted run receipt or canonical run record.

An item reports only pending interactions and never includes response values.

## Algorithms

The projection filters terminal runs before constructing items.

The projection appends queued entries after active runs and preserves journal order.

The projection returns no strip for fewer than two items.

The narrow renderer emits one bounded summary line with the item count and activity route.

The standard renderer emits up to three rows with bounded branch identities and priority-aware state, waiting, and control fields.

The wide renderer emits up to eight rows, includes unavailable control markers, and keeps detail in the selected activity view.

Long branch identities retain both a stable prefix and suffix while the canonical identifier remains unchanged in emitted intents.

The renderer sanitizes branch, state, runner, model, and action text before terminal output.

The activity view uses the existing searchable selector and opens detail in the full viewport.

## Concurrency

Projection runs against immutable state and never reads provider streams directly.

Rows update independently as each run commits events through the shared journal.

Focus changes commit one durable event and do not pause, cancel, or detach another run.

Interaction and control actions carry an explicit run identifier from the row to the application.

The strip remains conditional so one active run keeps the original transcript-first layout.

## Failures

Malformed provider text is sanitized before it reaches the strip or activity selector.

Missing runner or model values render as bounded unknown values rather than guessed identities.

An unavailable control has a `!` marker in the action list and remains disabled by the capability map.

An unknown run focus request returns a stable application error without changing state.

Terminal rows remain inspectable but cannot receive live cancellation or steering.

Rows select complete fields by priority before they elide a bounded branch identity, so controls never become partial words.

## Performance

The projection performs bounded scans over the existing run and queue arrays.

The renderer caps visible rows at eight on wide terminals and three on standard terminals.

The narrow renderer performs one string fit and adds no persistent pane.

The full activity selector reuses existing bounded filtering and row rendering.

## Tests

`test/application.test.ts` proves focus switching and explicit background interaction and cancellation routing.

The TUI test scopes prove keyboard focus dispatch, selector behavior, and stable narrow layouts.

The responsive terminal proof captures 40×12, 80×24, 120×40, and 200×60 layouts.

The visual capture records an eight-turn keyboard walkthrough, while TUI tests cover activity selection and focus dispatch.

## Non-goals

The Work Strip does not replace the transcript or duplicate provider output.

The Work Strip does not create a permanent activity pane at any terminal width.

The Work Strip does not decide provider capabilities or invent runner and model catalogs.

The Work Strip does not expose credentials, secret answers, raw provider payloads, or worker internals.
