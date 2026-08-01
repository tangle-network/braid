# Pi TUI compatibility ledger

## Published `0.83.0` alternate-screen gap

First carried: 2026-08-01.

Affected Braid file: `src/adapters/tui/alternate-screen-terminal.ts`.

The npm tarball for `@earendil-works/pi-tui@0.83.0` exports the `TUI` renderer, editor, overlays, and terminal interface, but it does not export the `TuiAltScreen`, `TuiMainScreen`, `ScrollView`, or stack-layout classes present on Pi main at commit `a6f7317dfca61e357aee65faafe012a1be6c3734`.

Braid temporarily wraps Pi's published `ProcessTerminal` with the standard `DECSET 1049` enter and leave sequences.

Pi still owns input, dimensions, focus, overlays, cell rendering, and cleanup.

The adapter contains no renderer and no application state.

Removal condition: replace the adapter with Pi's published alternate-screen class after a release exports it and the Braid PTY cleanup and resize cases pass unchanged.

Revalidation required on every Pi TUI update.
