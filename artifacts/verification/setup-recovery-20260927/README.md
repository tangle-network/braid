# Empty setup recovery

Recorded on September 27, 2026 with the actual terminal process and keyboard input.
Before frames use the installed public Braid 0.3.2 archive.
After frames use the source files identified in `source-hashes.json`.

## Visible change

| Size | Before | After |
| --- | --- | --- |
| 40 × 12 | [Before](before-40x12.png) | [After](after-40x12.png) |
| 80 × 24 | [Before](before-80x24.png) | [After](after-80x24.png) |
| 120 × 40 | [Before](before-120x40.png) | [After](after-120x40.png) |
| 200 × 60 | [Before](before-200x60.png) | [After](after-200x60.png) |

The primary action fits all four terminal sizes.
The setup guide and full diagnostics have separate, scrollable views.
Escape returns from either view, then leaves setup.
The maintained modal back contract carries that action through the outer terminal input handler.

## Recovery interaction

[Keyboard recording](recovery-flow.gif) · [Terminal events](recovery-flow.cast) · [Receipt](receipt.json)

The process opened in a fresh workspace with no profile and an unavailable loopback bridge.
An empty retry reported that no agents were found.
After a profile was saved in `.braid/profile.json`, retry discovered it without restarting Braid.
Keyboard selection then reached the connection chooser.
No selection was applied and no model was called.
This proves profile discovery and navigation, not authentication or model execution.

## Cancel during discovery

[Keyboard recording](cancel-flow.gif) · [Terminal events](cancel-flow.cast) · [Receipt](cancel-receipt.json)

A task-owned HTTP service delayed the two discovery responses.
Three rapid Enter presses caused exactly two HTTP reads: one health request and one model-catalog request.
Escape closed setup before those responses returned.
Releasing both responses did not redraw or reopen the closed wizard.
The workspace remained empty, with no configuration file.
This service exercised UI timing; it was not a real coding provider.

## Boundaries

All runs used isolated temporary workspaces, state directories, and random external database keys.
Production credentials were removed from the capture processes.
No model calls, package publication, or production changes occurred.
The public before archive SHA-256 is `476307aaf09ecca00eb9b8a7e21ccff5b1129bb807b0f3fb0c155d46d7ba096d`.
The after executable hash and timestamps are in the receipts.
