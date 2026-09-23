# Braid 0.3.0 screen demo (75 s)

This is a recording script; the final video is a separate artifact.
Every on-screen action is a Braid 0.3.0 command registered in `src/views/shared/command-registry.ts` or a flag in `src/bin/args.ts`.
Record from the published 0.3.0 package after the full protected Live Evidence gate passes.

## What the demo must show

1. One agent profile runs on two different local runners.
2. The same profile runs in a Tangle cloud sandbox.
3. The cloud run keeps working after Braid quits and the laptop closes, and Braid picks it up again.

Claude Code has local background sessions (`claude --bg`), so the demo must not imply that only Braid can leave a session running.
The contrast is where the work runs: a Tangle sandbox, with the laptop off.

## Setup before recording (off camera)

- A Local CLI Bridge on `http://127.0.0.1:3344`, started from the CLI Bridge checkout with `PI_EXECUTOR=host BRIDGE_JAIL_MODE=fs-jail BRIDGE_BACKENDS=pi,codex BRIDGE_PORT=3344 pnpm start`.
  Pi on Linux needs `fs-jail`.
  The Bridge checkout must include the Pi jail fix ([drewstone/cli-bridge#235](https://github.com/drewstone/cli-bridge/pull/235), merged as `de0c588`); without it, Pi fails with `EROFS` under `fs-jail`.
  The Bridge runs from source, so update it with `git pull && pnpm install` and restart it.
- A profile effort that Codex's default model accepts: `low`, `medium`, `high`, `xhigh`, or `max`, or no effort at all.
  Codex rejects `none` with `Unsupported value: 'none' is not supported with the 'gpt-6-astra' model`.
- A Tangle key in `BRAID_TANGLE_AUTH`, or saved during first-run setup.
- A small repository as the workspace, for example a failing `slugify` test.
- In `.braid/config.json`, a Tangle Sandbox connection named **Tangle Sandbox (retained)** with `"providerOptions": {"lifecycle": "retained", "idleTtlSeconds": 1800}`.
  First-run setup creates only ephemeral sandbox connections, so this edit is required.
- Use OpenCode with `tangle-router/glm-5.3` inside the sandbox, matching the 2026-09-01 retained proof.
- Terminal at 120×40 so the Work Strip shows its full rows.

## Shot list

| Time | Screen | Command | Voiceover |
| --- | --- | --- | --- |
| 0:00–0:06 | Empty terminal in the repository | `braid` | "Braid is a terminal for coding agents. One agent profile, any supported runner." |
| 0:06–0:16 | Braid opens with the profile and the Local CLI Bridge connection | `/runner pi`, then type: `Run the tests and tell me which one fails.` | "This turn runs through Pi on my machine." |
| 0:16–0:26 | Pi's answer streams; the status line shows runner and model | `/runner codex`, `/model default`, then type: `Fix the failing test.` | "Same profile, same conversation. The next turn runs through Codex with its default model." |
| 0:26–0:36 | Codex's answer streams | `/runner opencode`, `/model tangle-router/glm-5.3`, `/connection select <tangle-sandbox-id>`, then type: `Add edge-case tests for Unicode input and run the full suite.` | "Now the same profile runs through OpenCode in a Tangle cloud sandbox." |
| 0:36–0:42 | Sandbox run starts; the placement and usage labels appear | `/detach` | "I detach. The run keeps working in the sandbox." |
| 0:42–0:48 | `/quit`, then the laptop lid closes (cut) | `/quit` | "Braid is closed. So is the laptop." |
| 0:48–0:58 | Lid opens. New terminal. | `braid --conversation <id>`, then `/reconnect` | "Reopen the conversation and reconnect. Braid replays what happened while I was away, without duplicates." |
| 0:58–1:06 | Transcript fills in; the run finishes with token counts and a cost label | `/activity` | "Every run keeps its runner, model, profile snapshot, and usage. Estimated cost is labelled as an estimate." |
| 1:06–1:15 | End card: repository URL and `sandbox.tangle.tools`; the video description links to the [campaign signup route](https://sandbox.tangle.tools/?utm_source=x&utm_medium=social&utm_campaign=braid-0.3.0&ref=braid) | none | "Braid is MIT-licensed. The cloud sandbox runs on Tangle." |

## Evidence behind each claim

| Claim in the voiceover | Evidence |
| --- | --- |
| Same profile on Pi and Codex | The 0.3.0 packed CLI Bridge release proof ([`artifacts/verification/live/bridge/evidence.json`](../../artifacts/verification/live/bridge/evidence.json), merged in [#68](https://github.com/tangle-network/braid/pull/68)): LIVE-01..05 passed on Braid `5cafc42ff` with CLI Bridge `de0c588`, and LIVE-02 handed one conversation from Pi (`pi/tangle-router/glm-5.2`) to `codex/default`. The demo must set `/model default` after `/runner codex`; the runner override alone retains the Pi model. The earlier probe stall in [`evidence/braid-bridge/`](evidence/braid-bridge/) had three causes, all fixed: the Braid crash ([#66](https://github.com/tangle-network/braid/pull/66)), the Bridge jail ([drewstone/cli-bridge#235](https://github.com/drewstone/cli-bridge/pull/235)), and the `none` effort that Codex rejects ([#67](https://github.com/tangle-network/braid/pull/67)). Leave `reasoningEffort` out of the demo profile. |
| Same profile in a Tangle sandbox | LIVE-07 and the 2026-09-01 multirun proof (OpenCode in the sandbox). |
| Keeps working after detach and quit; replay without duplicates | 2026-08-15 retained cohort (SIGKILL and restore, 3 of 3) and the 2026-09-01 multirun proof (`noDuplicateEventIds: true`). |
| Cost labelled as an estimate | Runtime 0.252 reports sandbox cost without a billing receipt as an estimate (#61); Braid shows `~$` in `/activity` (`src/views/tui/terminal-usage.ts`). |

At recording time, replace `<tangle-sandbox-id>` and `<id>` with the actual connection and conversation identifiers from the live run.
Keep native terminal interaction out of this 75-second cut; its separate proof belongs in the release evidence.
