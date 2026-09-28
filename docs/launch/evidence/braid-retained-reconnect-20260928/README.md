# Retained cloud reconnect evidence

This receipt covers one real internal Tangle Sandbox run from Braid source commit `64ca8e10914d7f333514ec1d3237480da3887c4a`.

That checkout's package version metadata was `0.3.3`.
The published `@tangle-network/braid@0.3.3` package came from tag `v0.3.3` at commit `afc8380e06dbb164532d6d7af753394375c81c42`.
This run used a later source build.
It exercises a Workspace lifecycle selector added after the public release; [public 0.3.3 setup](../../../getting-started.md) uses the connection configuration shown there.
The recorded operator run does not demonstrate an outside-user flow.

The run ID is `run-c82ed4ec-a28f-46bb-9575-e388c45ff8f7`.

The sandbox ID is `sandbox-8e207ddb92f5`.

The Workspace form selected retained lifecycle with a 300-second idle timeout.

## Terminal replay

![Retained cloud detach and reconnect terminal replay](retained-reconnect.gif)

The asciinema cast and GIF replay the uncut PTY output in event order.

The source transcripts have no per-event timing sidecar.

The 16.1-second playback uses normalized timing and a 1.5-second process boundary.

Playback timing does not represent the original wall-clock duration.

The playback preserves terminal output, but it does not recreate keyboard input.

The final process emitted a Node.js color-environment warning after the completed result appeared.

## Captured states

The PNGs render states from the source PTY output at 120×40 with `@xterm/headless@6.0.0`.

- [Retained lifecycle and 300-second idle timeout](workspace-retained.png)
- [Write permission prompt](write-permission.png)
- [Detached run still active](run-detached.png)
- [Run visible as running remotely after reconnect](run-remote-running.png)
- [Recovered result](result-recovered.png)

## Machine-readable receipts

[`run-result.json`](run-result.json) records the detached and completed run states, cursor positions, and provider tool results.

The provider `read` tool returned `retained-reconnect-20260928`.

The assistant returned `retained-reconnect-20260928 verified`.

[`sandbox-inventory-receipt.json`](sandbox-inventory-receipt.json) shows the target sandbox present as running before cleanup and absent from the later 200-entry inventory.

The receipts include source file hashes and omit unrelated sandbox records.

The raw source captures remain in Fleet recovery scratch; their names, sizes, and hashes appear in `manifest.json`.

This artifact relies on the Braid provider run's recorded `read` result.

It does not rely on the separate manual `tangle fs cat` observation, whose output was not retained.

The inventory receipt does not contain the raw delete command output.
