# Retained cloud reconnect evidence

This receipt covers one real Braid 0.3.3 run against Tangle Sandbox.

The source revision is `64ca8e10914d7f333514ec1d3237480da3887c4a`.

The run ID is `run-c82ed4ec-a28f-46bb-9575-e388c45ff8f7`.

The sandbox ID is `sandbox-8e207ddb92f5`.

The Workspace form selected retained lifecycle with a 300-second idle timeout.

## Terminal replay

![Retained cloud detach and reconnect terminal replay](retained-reconnect.gif)

The asciinema cast and GIF replay the uncut PTY output in event order.

The two source transcripts are retained under `/home/drew/.local/state/fleet/recovery/session-recovery-20260926/braid-cloud-recovery-20260928/`.

Their SHA-256 digests and byte counts appear in `manifest.json`.

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

After `/detach` and `/quit`, the saved run state was detached and incomplete at cursor 109.

The reconnect reopened the same conversation and completed at cursor 157.

The assistant returned `retained-reconnect-20260928 verified`.

The read tool returned the exact file contents, `retained-reconnect-20260928`.

An independent Tangle CLI read verified the sandbox file before cleanup.

The sandbox was deleted after the check, and a later inventory did not contain its ID.
