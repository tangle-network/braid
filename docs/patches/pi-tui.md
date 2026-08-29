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

Revalidated: 2026-08-29 against `@earendil-works/pi-tui@0.84.4` from source commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`.

The published package still omits the virtual-terminal helper and still reserves alternate-screen viewport actions.

The current adapter remains necessary.

Proof: 156 virtual-terminal checks passed, and packed PTY checks passed at 40×12, 80×24, 120×40, and 200×60.
