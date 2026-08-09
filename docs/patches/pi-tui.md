# Pi TUI compatibility ledger

## Published `0.84.1` renderer split

First carried: 2026-08-01.

Resolved upstream: 2026-08-07 in `@earendil-works/pi-tui@0.84.1`.

Affected Braid file: `src/adapters/tui/alternate-screen-terminal.ts`.

The npm tarball now exports the `TUI` interface plus the concrete `TuiMainScreen`, `TuiAltScreen`, `ScrollView`, and stack-layout classes.

Braid imports `TuiMainScreen` explicitly and pairs it with either `ProcessTerminal` for inline mode or its small `DECSET 1049` terminal adapter for full-screen mode.

The local adapter remains an application choice because Braid already projects its complete conversation history into a bounded screen and must receive its own Page Up, Page Down, Home, and End actions; Pi's `TuiAltScreen` owns and consumes those viewport actions before application listeners.

The adapter contains no renderer, viewport, input handler, or application state.

Removal condition: replace the adapter with `TuiAltScreen` only if Braid moves transcript history into Pi's `ScrollView` without losing the current keyboard, restart, visual, and full-history checks.

Revalidation required on every Pi TUI update.
